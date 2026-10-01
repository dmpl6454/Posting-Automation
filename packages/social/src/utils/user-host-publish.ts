/**
 * Outcome mapping for publishes to a server the USER named (a Mastodon
 * instance, a self-hosted WordPress site). Shared so the two providers cannot
 * drift apart.
 *
 * Three outcomes, by phase:
 *  - create (the request that makes the post): after it reached the server, an
 *    unknown outcome is an AmbiguousPublishError — the worker parks it as
 *    "Needs check" and NO retry layer re-runs it (2026-08-18 duplicate posts).
 *    Before it reached the server, it is a plain, retryable error.
 *  - media: never ambiguous, because no post exists until the create. Transport
 *    and 5xx failures are retryable; a duplicate media upload is harmless.
 *  - read (profile, delete, token exchange): plain errors.
 * Refusals that retrying cannot fix (private address, redirect, rejected
 * credentials, rejected post) are a PublishRefusedError in every phase.
 *
 * ⚠️ Every message is FIXED text, apart from a short, sanitised summary of the
 * platform's own error on a 4xx rejection (a terminal error, never classified).
 * Retryable messages go through the publish worker's classifyError(), which
 * substring-matches "token"+"invalid", "401", "403", "permission", "rate
 * limit", "too many", "too large", "too long" and more — any of those in a
 * retryable message would send it down a branch that re-publishes. They are
 * locked by apps/worker/src/__tests__/user-host-publish-classification.test.ts.
 * Never put a hostname, an address or a response body in them.
 *
 * They also never say "will retry": the same text is stored as the target's
 * error on the FINAL attempt, when no retry follows (review, 2026-10-01).
 */
import { AmbiguousPublishError } from "./ambiguous-publish";
import { PublishRefusedError } from "./publish-refused";
import { isUserHostError } from "./user-host-fetch";

export interface UserHostService {
  platform: "MASTODON" | "WORDPRESS" | "DISCORD";
  /** Product name, used at the start of messages. */
  product: string;
  /** "the Mastodon instance" — the server the user named. */
  place: string;
  /** Where to look for a post that may already exist. */
  checkWhere: string;
  /** What to do when the credentials are refused. */
  credentialsHelp: string;
}

export const MASTODON_SERVICE: UserHostService = {
  platform: "MASTODON",
  product: "Mastodon",
  place: "the Mastodon instance",
  checkWhere: "your Mastodon profile",
  credentialsHelp:
    "access token (HTTP {status}). Generate a new one under Preferences → Development on your instance and reconnect the channel.",
};

export const WORDPRESS_SERVICE: UserHostService = {
  platform: "WORDPRESS",
  product: "WordPress",
  place: "the WordPress site",
  checkWhere: "Posts (including Drafts) in WordPress",
  credentialsHelp:
    "application password (HTTP {status}). Create a new Application Password in WordPress and reconnect the channel.",
};

/**
 * Discord WEBHOOK channels. The host is not user-chosen (the connect-time
 * validator pins it to discord.com), but the publish must follow the same
 * duplicate-post rules, so it uses the same client and mapping.
 */
export const DISCORD_SERVICE: UserHostService = {
  platform: "DISCORD",
  product: "Discord",
  place: "Discord",
  checkWhere: "the Discord channel",
  credentialsHelp:
    "webhook (HTTP {status}). It may have been deleted or reset — create a new webhook in the channel's settings and reconnect the channel.",
};

export type UserHostPhase = "create" | "media" | "read";

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "ENODATA", "ESERVFAIL"]);

function reasonFor(code: string): string {
  if (DNS_CODES.has(code)) return "its address could not be looked up";
  if (code === "ECONNREFUSED") return "the connection was refused";
  if (code === "ETIMEDOUT") return "no answer in time";
  return "the connection failed";
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The post may already exist: park it, never retry it automatically. */
export function unconfirmedCreate(svc: UserHostService, why: string, cause?: unknown): AmbiguousPublishError {
  return new AmbiguousPublishError(
    `${svc.product} did not confirm whether this post was published (${why}). It may already be live — check ${svc.checkWhere}, then use "It didn't publish" to try again.`,
    { platform: svc.platform, cause },
  );
}

function refused(svc: UserHostService, reason: PublishRefusedError["reason"], message: string, cause?: unknown) {
  return new PublishRefusedError(message, { reason, platform: svc.platform, cause });
}

/** A media step failed. No post exists yet, so retrying is safe. */
export function retryableMediaFailure(svc: UserHostService, why: string, cause?: unknown): Error {
  return new Error(`${svc.product} media upload did not finish (${why}). No post was created.`, { cause });
}
const mediaRetry = retryableMediaFailure;

/** Map a userHostFetch failure (or anything thrown around it) to the error to throw. */
export function userHostFailure(err: unknown, svc: UserHostService, phase: UserHostPhase): Error {
  if (!isUserHostError(err)) {
    // Not from the client (a bug, or an encoding error). For a create we cannot
    // prove nothing was sent, so it is unconfirmed rather than retried.
    if (phase === "create") return unconfirmedCreate(svc, "the request ended unexpectedly", err);
    if (phase === "media") return mediaRetry(svc, "an unexpected error", err);
    return new Error(`The request to ${svc.place} failed unexpectedly.`, { cause: err });
  }
  switch (err.kind) {
    case "blocked":
      return refused(
        svc,
        "unsafe_destination",
        `Publishing blocked: ${svc.place}'s address points to a private or internal network, which PostAutomation never connects to. Nothing was sent. Reconnect the channel using its public address.`,
        err,
      );
    case "bad_url":
      return refused(
        svc,
        "unsafe_destination",
        `Publishing blocked: ${svc.place}'s saved address is not a plain web address. Nothing was sent. Reconnect the channel.`,
        err,
      );
    case "redirect":
      // 303 See Other means "handled, look elsewhere": the post may exist.
      if (phase === "create" && err.status === 303) {
        return unconfirmedCreate(svc, `${svc.place} answered with a redirect that says the request was handled`, err);
      }
      return refused(
        svc,
        "redirect",
        `Publishing stopped: ${svc.place} answered with a redirect (HTTP ${err.status}) instead of handling the request. Redirects are never followed, so nothing was created. Check the channel's address (http or https, with or without www) and reconnect it.`,
        err,
      );
    case "response_too_big":
    case "bad_status":
      if (phase === "create") return unconfirmedCreate(svc, `${svc.place}'s reply could not be read`, err);
      if (phase === "media") return mediaRetry(svc, "the reply could not be read", err);
      return new Error(`${capitalize(svc.place)}'s reply could not be read.`, { cause: err });
    case "transport":
      if (phase === "create") {
        if (err.requestSent) return unconfirmedCreate(svc, `${svc.place} stopped responding after the post was sent`, err);
        return new Error(`Could not reach ${svc.place} (${reasonFor(err.code)}). Nothing was sent.`, { cause: err });
      }
      if (phase === "media") return mediaRetry(svc, reasonFor(err.code), err);
      return new Error(`Could not reach ${svc.place} (${reasonFor(err.code)}).`, { cause: err });
  }
}

/** Short, sanitised summary of a platform's own error body. Never the raw body. */
export function summarizeRemoteError(data: unknown, max = 200): string {
  let text = "";
  if (data && typeof data === "object") {
    text = ["code", "error", "message", "error_description"]
      .map((k) => (data as Record<string, unknown>)[k])
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .join(" — ");
  } else if (typeof data === "string") {
    text = data;
  }
  const clean = text
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return clean || "no details";
}

async function readBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

/** Map a non-2xx response to the error to throw. */
export async function userHostStatusFailure(res: Response, svc: UserHostService, phase: UserHostPhase): Promise<Error> {
  const status = res.status;
  if (status === 401 || status === 403) {
    return refused(
      svc,
      "credentials",
      `${svc.product} did not accept this channel's ${svc.credentialsHelp.replace("{status}", String(status))}`,
    );
  }
  if (status === 429) {
    const tail = phase === "read" ? "" : " Nothing was created.";
    return new Error(`${capitalize(svc.place)} asked us to slow down (HTTP 429).${tail}`);
  }
  if (status >= 500) {
    if (phase === "create") return unconfirmedCreate(svc, `${svc.place} returned HTTP ${status} after the post was sent`);
    if (phase === "media") {
      return new Error(`${svc.product} media upload failed on the server (HTTP ${status}). No post was created.`);
    }
    return new Error(`${capitalize(svc.place)} returned HTTP ${status}.`);
  }
  const thing = phase === "create" ? "post" : phase === "media" ? "media upload" : "request";
  // Always a refusal, in every phase: this message carries the SERVER's own
  // words, and a terminal error is never passed through classifyError — a
  // plain error saying "rate limit" or "token invalid" would steer it.
  return refused(
    svc,
    "rejected",
    `${svc.product} rejected the ${thing} (HTTP ${status}): ${summarizeRemoteError(await readBody(res))}`,
  );
}
