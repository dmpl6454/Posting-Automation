/**
 * Private replies + Messenger / Instagram Direct messages (2026-10-05) — the
 * pure half: types, parsers, capability rules, error classification and the
 * fixed user-facing messages. The Graph calls live on FacebookProvider (every
 * one of them uses a PAGE access token on graph.facebook.com, including the
 * Instagram ones, so they share the Page-aware rate-limit wrapper).
 *
 * Meta's contract (developers.facebook.com, read 2026-10-05):
 *
 *   PRIVATE REPLY (one message to the person who left a comment)
 *     Facebook   POST /{page-id}/messages  {recipient:{comment_id}, message:{text}}
 *                Page token · pages_messaging · a person with the MESSAGING task
 *     Instagram  POST /{ig-user-id}/messages (same body), the LINKED Page's token ·
 *                instagram_basic + instagram_manage_comments + pages_read_engagement
 *     Limits: within 7 days of the comment, ONE message per comment; anything
 *     more only after the person answers, inside the 24-hour window.
 *
 *   CONVERSATIONS (the DM inbox)
 *     GET  /{page-id}/conversations?platform=messenger|instagram
 *     GET  /{conversation-id}?fields=messages{…}   — details for the 20 newest only
 *     POST /{page-id}/messages {recipient:{id}, messaging_type:"RESPONSE", message:{text}}
 *     Facebook   pages_messaging + pages_manage_metadata + pages_read_engagement
 *     Instagram  instagram_basic + instagram_manage_messages + pages_manage_metadata
 *     Sending is only allowed inside the 24-hour "standard messaging window"
 *     that opens when the person messages you.
 *
 * Text limits: Messenger 2,000 characters; Instagram 1,000 BYTES of UTF-8.
 */

import { isIndeterminateReplyError } from "./social-comments";

export type MessagingPlatform = "FACEBOOK" | "INSTAGRAM";

export const STANDARD_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const MESSENGER_TEXT_MAX_CHARS = 2000;
export const INSTAGRAM_DM_TEXT_MAX_BYTES = 1000;

/** Message details are only readable for the 20 newest messages of a conversation. */
export const CONVERSATION_MESSAGE_DETAIL_LIMIT = 20;
export const CONVERSATION_PAGE_SIZE = 25;

// ── Capabilities ─────────────────────────────────────────────────────────

export const PRIVATE_REPLY_SCOPES: Record<MessagingPlatform, string[]> = {
  FACEBOOK: ["pages_messaging"],
  INSTAGRAM: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"],
};

export const INBOX_SCOPES: Record<MessagingPlatform, string[]> = {
  FACEBOOK: ["pages_messaging", "pages_manage_metadata", "pages_read_engagement"],
  INSTAGRAM: ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"],
};

export interface MessagingCapabilities {
  /** false when the grant has never been read — every flag is then null. */
  known: boolean;
  canPrivateReply: boolean | null;
  /** List conversations, read them and send inside the 24-hour window. */
  canUseInbox: boolean | null;
  missingForPrivateReply: string[];
  missingForInbox: string[];
}

export function messagingCapabilities(
  platform: MessagingPlatform,
  grantedScopes: readonly string[] | null | undefined
): MessagingCapabilities {
  if (!Array.isArray(grantedScopes)) {
    return { known: false, canPrivateReply: null, canUseInbox: null, missingForPrivateReply: [], missingForInbox: [] };
  }
  const missing = (scopes: string[]) => scopes.filter((s) => !grantedScopes.includes(s));
  const missingForPrivateReply = missing(PRIVATE_REPLY_SCOPES[platform]);
  const missingForInbox = missing(INBOX_SCOPES[platform]);
  return {
    known: true,
    canPrivateReply: missingForPrivateReply.length === 0,
    canUseInbox: missingForInbox.length === 0,
    missingForPrivateReply,
    missingForInbox,
  };
}

// ── Ids ──────────────────────────────────────────────────────────────────

/**
 * A conversation id from the client. It is interpolated into a Graph URL PATH
 * (encodeURIComponent at the call site is the second layer), so the shape is
 * constrained here first: Messenger ids look like `t_1234…`, Instagram ids are
 * URL-safe base64 (`aWdfZAG06…`). `/ ? # & %` and whitespace are refused.
 *
 * A purely numeric (or `{a}_{b}` numeric) value is ALSO refused: that is the
 * shape of a Page, post, comment or user node, never a conversation, and
 * refusing it keeps this input from being pointed at some other Graph object.
 */
const CONVERSATION_ID_RE = /^[A-Za-z0-9_\-=.]{4,300}$/;
const NUMERIC_NODE_RE = /^\d+(_\d+)?$/;

export function isValidConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_RE.test(value) && !NUMERIC_NODE_RE.test(value);
}

// ── Text limits ──────────────────────────────────────────────────────────

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A user-facing reason the text is too long for this platform, else null. */
export function messageTextTooLong(platform: MessagingPlatform, text: string): string | null {
  if (platform === "INSTAGRAM") {
    return utf8ByteLength(text) > INSTAGRAM_DM_TEXT_MAX_BYTES
      ? "Instagram messages can be at most 1,000 bytes — about 1,000 letters, fewer with emoji or non-Latin scripts."
      : null;
  }
  return text.length > MESSENGER_TEXT_MAX_CHARS ? "Messenger messages can be at most 2,000 characters." : null;
}

// ── Shapes ───────────────────────────────────────────────────────────────

export interface MessageParticipant {
  id: string;
  /** Facebook display name; null on Instagram. */
  name: string | null;
  /** Instagram handle without "@"; null on Facebook. */
  username: string | null;
}

export interface SocialConversation {
  id: string;
  /** ISO-ish timestamp as Graph returns it; "" if absent. */
  updatedAt: string;
  /** The OTHER person in the thread (never the Page / account itself). */
  participant: MessageParticipant | null;
  /** Text of the newest message, when Meta returned it ("" otherwise). */
  snippet: string;
  /** Did the Page / account send the newest message? null when unknown. */
  lastFromAccount: boolean | null;
  /** Meta's unread count (Messenger); null when not reported. */
  unreadCount: number | null;
}

export interface SocialConversationPage {
  conversations: SocialConversation[];
  nextCursor: string | null;
}

export interface MessageAttachment {
  /** "image" | "video" | "audio" | "file" | "share" | "other" */
  kind: string;
  /** A displayable IMAGE url (image or a video/share preview), else null. */
  previewUrl: string | null;
  /** Link to open the attachment (file, video, shared post), when given. */
  url: string | null;
  name: string | null;
}

export interface SocialMessage {
  id: string;
  text: string;
  createdAt: string;
  fromAccount: boolean;
  from: MessageParticipant | null;
  attachments: MessageAttachment[];
}

export interface SocialConversationThread {
  id: string;
  participant: MessageParticipant | null;
  /** Oldest first, at most CONVERSATION_MESSAGE_DETAIL_LIMIT. */
  messages: SocialMessage[];
  /** Newest message the PERSON sent, among those loaded. */
  lastInboundAt: string | null;
  /**
   * Is the 24-hour window open? true/false when the loaded messages decide it;
   * null when they cannot (only our own messages loaded, and there may be
   * older ones from the person beyond the 20 Meta details).
   */
  windowOpen: boolean | null;
  /** When the window closes (ISO), if it is open. */
  windowClosesAt: string | null;
}

// ── Parsers ──────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Graph timestamps ("2026-10-05T10:00:00+0000") → epoch ms; NaN if unparseable. */
export function parseGraphTimestamp(value: string): number {
  if (!value) return NaN;
  const iso = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return Date.parse(iso);
}

function toParticipant(raw: any): MessageParticipant | null {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id != null ? String(raw.id) : "";
  if (!id) return null;
  return {
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : null,
    username: typeof raw.username === "string" && raw.username ? raw.username : null,
  };
}

/** The participant that is not the account itself (first one wins). */
export function otherParticipant(participants: unknown, ownIds: readonly string[]): MessageParticipant | null {
  const list: any[] = Array.isArray((participants as any)?.data) ? (participants as any).data : [];
  for (const raw of list) {
    const p = toParticipant(raw);
    if (p && !ownIds.includes(p.id)) return p;
  }
  return null;
}

/** Does the participants list include the account itself? */
export function includesAccount(participants: unknown, ownIds: readonly string[]): boolean {
  const list: any[] = Array.isArray((participants as any)?.data) ? (participants as any).data : [];
  return list.some((raw) => raw && ownIds.includes(String(raw.id ?? "")));
}

const IMAGE_URL_RE = /^https:\/\//i;

function safeHttpsUrl(v: unknown): string | null {
  return typeof v === "string" && IMAGE_URL_RE.test(v) ? v : null;
}

function toAttachments(raw: any): MessageAttachment[] {
  const list: any[] = Array.isArray(raw?.data) ? raw.data : [];
  return list.slice(0, 10).map((a) => {
    const mime = str(a?.mime_type).toLowerCase();
    const image = safeHttpsUrl(a?.image_data?.url) ?? safeHttpsUrl(a?.image_data?.preview_url);
    const videoPreview = safeHttpsUrl(a?.video_data?.preview_url);
    const videoUrl = safeHttpsUrl(a?.video_data?.url);
    const file = safeHttpsUrl(a?.file_url);
    let kind = "other";
    if (image || mime.startsWith("image/")) kind = "image";
    else if (a?.video_data || mime.startsWith("video/")) kind = "video";
    else if (mime.startsWith("audio/")) kind = "audio";
    else if (file) kind = "file";
    return {
      kind,
      // Only ever an IMAGE url — a video file must never reach an <img>.
      previewUrl: image ?? videoPreview,
      url: videoUrl ?? file ?? image,
      name: typeof a?.name === "string" && a.name ? a.name : null,
    };
  });
}

function toMessage(raw: any, ownIds: readonly string[]): SocialMessage | null {
  if (!raw || raw.id == null) return null;
  const from = toParticipant(raw.from);
  const attachments = toAttachments(raw.attachments);
  // A shared post / story reply arrives as `shares` / `story` with no text.
  const shareLink = safeHttpsUrl(raw?.shares?.data?.[0]?.link);
  if (shareLink) attachments.push({ kind: "share", previewUrl: null, url: shareLink, name: null });
  return {
    id: String(raw.id),
    text: str(raw.message),
    createdAt: str(raw.created_time),
    fromAccount: from ? ownIds.includes(from.id) : false,
    from,
    attachments,
  };
}

/** Only surface a cursor when Meta's `paging.next` says another page exists. */
function nextCursor(paging: any): string | null {
  return paging?.next ? (typeof paging?.cursors?.after === "string" ? paging.cursors.after : null) : null;
}

export function parseConversationsPage(data: any, ownIds: readonly string[]): SocialConversationPage {
  const rows: any[] = Array.isArray(data?.data) ? data.data : [];
  const conversations: SocialConversation[] = [];
  for (const row of rows) {
    if (!row || row.id == null) continue;
    const newest = Array.isArray(row?.messages?.data) ? row.messages.data[0] : undefined;
    const newestFrom = toParticipant(newest?.from);
    const unread = Number(row.unread_count);
    conversations.push({
      id: String(row.id),
      updatedAt: str(row.updated_time),
      participant: otherParticipant(row.participants, ownIds),
      snippet: str(newest?.message) || str(row.snippet),
      lastFromAccount: newestFrom ? ownIds.includes(newestFrom.id) : null,
      unreadCount: Number.isFinite(unread) && unread >= 0 ? Math.floor(unread) : null,
    });
  }
  return { conversations, nextCursor: nextCursor(data?.paging) };
}

export function parseConversationThread(
  data: any,
  ownIds: readonly string[],
  now: number = Date.now()
): SocialConversationThread {
  const rows: any[] = Array.isArray(data?.messages?.data) ? data.messages.data : [];
  // Graph returns newest first; the thread renders oldest first.
  const messages = rows
    .slice(0, CONVERSATION_MESSAGE_DETAIL_LIMIT)
    .map((r) => toMessage(r, ownIds))
    .filter((m): m is SocialMessage => m !== null)
    .reverse();

  let lastInbound: SocialMessage | null = null;
  for (const m of messages) if (!m.fromAccount) lastInbound = m;

  let windowOpen: boolean | null;
  let windowClosesAt: string | null = null;
  const inboundAt = lastInbound ? parseGraphTimestamp(lastInbound.createdAt) : NaN;
  if (Number.isFinite(inboundAt)) {
    const closes = inboundAt + STANDARD_MESSAGING_WINDOW_MS;
    windowOpen = closes > now;
    windowClosesAt = windowOpen ? new Date(closes).toISOString() : null;
  } else if (lastInbound) {
    windowOpen = null;
  } else {
    // Only our own messages loaded. With fewer than the detail limit we have
    // the whole conversation and the person never wrote (e.g. after a private
    // reply) — closed. At the limit, older messages may hold theirs — unknown.
    windowOpen = rows.length >= CONVERSATION_MESSAGE_DETAIL_LIMIT ? null : false;
  }

  return {
    id: String(data?.id ?? ""),
    participant: otherParticipant(data?.participants, ownIds),
    messages,
    lastInboundAt: lastInbound?.createdAt || null,
    windowOpen,
    windowClosesAt,
  };
}

/**
 * Can a private reply still be sent for a comment created at `createdAt`?
 * true / false, or null when the timestamp is missing or unparseable (then
 * Meta decides).
 */
export function privateReplyWindowOpen(createdAt: string, now: number = Date.now()): boolean | null {
  const t = parseGraphTimestamp(createdAt);
  if (!Number.isFinite(t)) return null;
  return now - t < PRIVATE_REPLY_WINDOW_MS;
}

// ── Errors ───────────────────────────────────────────────────────────────

export interface MessagingErrorLike {
  code?: number | string;
  error_subcode?: number | string;
  message?: string;
}

export type MessagingFailure =
  | "token"
  | "permission"
  | "window_closed"
  | "already_sent"
  | "unavailable"
  | "too_old"
  | "throttled"
  | "not_found"
  | "other";

/**
 * Classify a refused messaging call. Order matters:
 *  - #190 first (a dead token is never "not approved");
 *  - the window / already-replied / unavailable cases before the generic #10
 *    permission family, because Meta reports several of them as `#10` too.
 */
export function classifyMessagingError(err: MessagingErrorLike | undefined | null): MessagingFailure {
  if (!err) return "other";
  const code = Number(err.code);
  const sub = Number(err.error_subcode);
  const msg = String(err.message ?? "");
  if (code === 190) return "token";
  if (/more than once|already (been )?(sent|replied|responded)|only (send|reply)[^.]*once|reply to this comment again/i.test(msg)) {
    return "already_sent";
  }
  if (sub === 2018278 || sub === 1545041 || /outside (of )?(the )?allowed window|messaging window/i.test(msg)) {
    return "window_closed";
  }
  if (/7 days|too old|has expired|no longer available for (a )?private repl/i.test(msg)) return "too_old";
  if (code === 551 || sub === 2018108 || sub === 2534014 || /isn't available|not available right now|cannot be messaged|can't message/i.test(msg)) {
    return "unavailable";
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 368 || (code >= 80000 && code <= 80099)) {
    return "throttled";
  }
  if (code === 100 && sub === 33) return "not_found";
  if (code === 10 || code === 3 || (code >= 200 && code <= 299)) return "permission";
  if (code === 100 && /^\(#100\) missing permission\b/i.test(msg)) return "permission";
  return "other";
}

/** Outcome unknown — a 5xx, a transient 4xx, an unreadable body or no id. */
export function isIndeterminateMessagingError(status: number, body: { error?: unknown } | null | undefined): boolean {
  if (status >= 500) return true;
  return isIndeterminateReplyError(body);
}

const PLATFORM_WORD: Record<MessagingPlatform, string> = { FACEBOOK: "Facebook", INSTAGRAM: "Instagram" };
const ACCOUNT_WORD: Record<MessagingPlatform, string> = { FACEBOOK: "Page", INSTAGRAM: "account" };

export function messagingFailureMessage(
  platform: MessagingPlatform,
  failure: MessagingFailure,
  op: "private_reply" | "list" | "thread" | "send"
): string {
  const p = PLATFORM_WORD[platform];
  const a = ACCOUNT_WORD[platform];
  switch (failure) {
    case "token":
      return `${p} rejected this ${a}'s connection. Reconnect the channel on the Channels page, then try again.`;
    case "permission":
      return op === "private_reply"
        ? `This ${a} hasn't granted permission to send private replies. Reconnect the channel on the Channels page (choose “Edit settings” and keep it ticked). If it still doesn't work, Meta hasn't approved messaging for accounts outside our own team yet.`
        : `This ${a} hasn't granted access to its messages. Reconnect the channel on the Channels page (choose “Edit settings” and keep it ticked). If it still doesn't work, Meta hasn't approved messaging for accounts outside our own team yet. You also need a role on the ${platform === "FACEBOOK" ? "Page" : "linked Facebook Page"} that can manage messages.`;
    case "window_closed":
      return "You can only message someone within 24 hours of their last message. Wait for them to write again.";
    case "already_sent":
      return "A private reply has already been sent for this comment. Meta allows only one — continue the conversation in Messages once they answer.";
    case "too_old":
      return "This comment is more than 7 days old. Meta only allows private replies within 7 days of a comment.";
    case "unavailable":
      return "This person can't be messaged right now — they may have blocked the account, deactivated, or limited who can message them.";
    case "throttled":
      return `${p} is temporarily limiting messages from this ${a}. Please wait a few minutes before trying again.`;
    case "not_found":
      return op === "private_reply"
        ? "That comment no longer exists — it may have been deleted."
        : "That conversation is no longer available.";
    default:
      return op === "list"
        ? `${p} couldn't load the messages right now. Please try again in a moment.`
        : op === "thread"
          ? `${p} couldn't load this conversation right now. Please try again in a moment.`
          : `${p} couldn't send that message right now. Please try again in a moment.`;
  }
}

/**
 * A send whose outcome is unknown. Creating a message is not idempotent, so
 * this must never read as a plain failure.
 */
export function messageUnconfirmedMessage(platform: MessagingPlatform, op: "private_reply" | "send"): string {
  return op === "private_reply"
    ? `${PLATFORM_WORD[platform]} didn't confirm the private reply. It may already have been sent — check Messages before trying again.`
    : `${PLATFORM_WORD[platform]} didn't confirm that message. It may already have been sent — refresh the conversation before sending again.`;
}

/** Recognises every unconfirmed-send message above (used by the UI + router). */
export function isMessageUnconfirmedText(message: unknown): boolean {
  return /didn't confirm (the private reply|that message)/i.test(String(message ?? ""));
}

export const MESSAGING_PAGE_LINK_MISSING_MESSAGE =
  "We couldn't find the Facebook Page linked to this Instagram account. Reconnect the channel on the Channels page (choose “Edit settings” and tick the Page it's linked to).";

/**
 * Thrown by every messaging call. `failure` lets the router react (re-read the
 * grant on "permission", record "already_sent"), `unconfirmed` marks an
 * outcome we could not prove either way. Read these fields duck-typed — never
 * with `instanceof` (pnpm's isolated layout can load two copies of a module).
 */
export class MessagingError extends Error {
  readonly failure: MessagingFailure | "unconfirmed" | "page_link_missing";
  readonly unconfirmed: boolean;
  constructor(message: string, failure: MessagingFailure | "unconfirmed" | "page_link_missing") {
    super(message);
    this.name = "MessagingError";
    this.failure = failure;
    this.unconfirmed = failure === "unconfirmed";
  }
}

export function messagingFailureOf(err: unknown): MessagingError["failure"] | null {
  const f = (err as any)?.failure;
  return typeof f === "string" ? (f as MessagingError["failure"]) : null;
}
