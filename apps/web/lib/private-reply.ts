/**
 * "Reply privately" on a comment (2026-10-05) — what the button shows and
 * whether it can be pressed. Pure so the rules are tested without a browser.
 *
 * Meta's rules: one private message per comment, within 7 days of the
 * comment. Facebook needs pages_messaging; Instagram only its comment
 * permission. The server enforces all of it again — this keeps the button
 * honest so nobody types a message Meta will refuse.
 */

export type PrivateReplyRecord = { status: string; at: string } | undefined;

export interface PrivateReplyCaps {
  known: boolean;
  canPrivateReply: boolean | null;
  missingForPrivateReply: string[];
}

export interface PrivateReplyState {
  /** Show the action at all (never on the account's own comments). */
  show: boolean;
  disabled: boolean;
  /** Tooltip / reason text. */
  title: string;
  /** "sent" → a badge instead of the button; "unconfirmed" → retry allowed with a warning. */
  status: "none" | "sent" | "unconfirmed";
}

export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Graph timestamps ("…+0000") → epoch ms; NaN if unparseable (Safari-safe). */
function parseTime(value: string): number {
  if (!value) return NaN;
  return Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

export function privateReplyState(opts: {
  isOwn: boolean;
  createdAt: string;
  platform: "FACEBOOK" | "INSTAGRAM";
  caps: PrivateReplyCaps | undefined;
  record: PrivateReplyRecord;
  now?: number;
}): PrivateReplyState {
  const now = opts.now ?? Date.now();
  if (opts.isOwn) return { show: false, disabled: true, title: "", status: "none" };
  if (opts.record?.status === "SENT") {
    return { show: true, disabled: true, title: "A private reply was sent for this comment — Meta allows only one.", status: "sent" };
  }
  const status = opts.record?.status === "UNCONFIRMED" ? "unconfirmed" : "none";
  if (opts.caps?.known === true && opts.caps.canPrivateReply === false) {
    const scopes = opts.caps.missingForPrivateReply.join(", ");
    return {
      show: true,
      disabled: true,
      title: `Needs the ${scopes} permission — reconnect this ${opts.platform === "FACEBOOK" ? "Page" : "account"} on the Channels page`,
      status,
    };
  }
  const t = parseTime(opts.createdAt);
  if (Number.isFinite(t) && now - t >= PRIVATE_REPLY_WINDOW_MS) {
    return { show: true, disabled: true, title: "Private replies are only possible within 7 days of a comment.", status };
  }
  return {
    show: true,
    disabled: false,
    title:
      opts.platform === "INSTAGRAM"
        ? "Send one private message to this person. It lands in their Instagram inbox (in Requests if they don't follow you)."
        : "Send one private message to this person in Messenger.",
    status,
  };
}

/** Instagram counts UTF-8 bytes (1,000); Messenger counts characters (2,000). */
export function privateMessageLength(platform: "FACEBOOK" | "INSTAGRAM", text: string): { used: number; max: number } {
  if (platform === "INSTAGRAM") return { used: new TextEncoder().encode(text).length, max: 1000 };
  return { used: text.length, max: 2000 };
}
