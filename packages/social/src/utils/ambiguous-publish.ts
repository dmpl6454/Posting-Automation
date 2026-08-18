/**
 * "Did the post actually go live?" — the question that caused the 2026-08-13
 * duplicate-post incident.
 *
 * Instagram's `media_publish` returned `code: 2, is_transient: true` while
 * HAVING ALREADY CREATED the post. The worker recorded FAILED, and because
 * FAILED sits inside the publish worker's atomic claim set
 * (SCHEDULED|FAILED|DRAFT → PUBLISHING), every retry layer re-ran a
 * NON-IDEMPOTENT create. Measured on production: 11 of 11 "failed" Instagram
 * targets were actually live, and one account received 5 copies of the same reel.
 *
 * The lesson encoded here: an error tells you the REQUEST failed. It does not
 * tell you the WRITE failed. Those are only the same thing for an idempotent
 * operation, and publishing a post is not one.
 *
 * ⚠️ THE ASYMMETRY IS LOAD-BEARING. Getting this wrong in the two directions
 * costs wildly different amounts:
 *   - wrongly "indeterminate" ⇒ the user re-publishes by hand once;
 *   - wrongly "definitely failed" ⇒ a duplicate post on a live audience account.
 * So when the evidence is unclear, the answer is INDETERMINATE.
 */

/** Node/undici error codes that prove the request never reached the platform. */
const SAFE_CONNECT_CODES = new Set([
  // Nothing was ever sent: no socket, no DNS answer, or a TLS handshake refusal.
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_INVALID_URL",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
]);

/**
 * Message shapes that mean "the request was dispatched and we never learned the
 * outcome". `fetch failed` is undici's generic wrapper, so it lands here unless
 * its `cause.code` proves otherwise (see SAFE_CONNECT_CODES).
 */
const INDETERMINATE_MESSAGE_PATTERNS: RegExp[] = [
  /fetch failed/i,
  /socket hang up/i,
  /\bterminated\b/i,
  /\baborted\b/i,
  /timed? ?out/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /EPIPE/,
  /UND_ERR_SOCKET/,
];

/**
 * A publish attempt whose outcome could not be determined: the platform may
 * already hold the post.
 *
 * The worker treats this as TERMINAL — it parks the target so that no retry
 * layer (BullMQ `attempts`, the reconciliation cron, or a human clicking Retry)
 * can re-run the create. See `ambiguousAt` on PostTarget.
 */
export class AmbiguousPublishError extends Error {
  /**
   * ⚠️ Duck-typed on purpose — do NOT switch callers to `instanceof`.
   * Under pnpm's isolated node_modules the worker and a provider can resolve
   * different copies of this module, which makes `instanceof` silently false and
   * would drop the target straight back into the re-publishing path this class
   * exists to prevent.
   */
  readonly isAmbiguousPublish = true as const;
  readonly platform?: string;

  constructor(message: string, opts?: { platform?: string; cause?: unknown }) {
    super(message);
    this.name = "AmbiguousPublishError";
    if (opts?.platform) this.platform = opts.platform;
    if (opts?.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** True when `err` is an AmbiguousPublishError (duck-typed — see the class note). */
export function isAmbiguousPublishError(err: unknown): err is AmbiguousPublishError {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { isAmbiguousPublish?: unknown }).isAmbiguousPublish === true
  );
}

/** Pull Meta's structured error object out of a `...: {"error":{...}}` message. */
function parseMetaError(message: string): Record<string, unknown> | null {
  const start = message.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(start)) as { error?: Record<string, unknown> };
    return parsed && typeof parsed === "object" && parsed.error ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * Should a failure at the PLATFORM-WRITE step be treated as "we don't know
 * whether the post was created"?
 *
 * ⚠️ Only ever call this for an error raised by the call that actually creates
 * the post (Instagram `media_publish`, Facebook `/feed`, …). Errors from
 * *earlier* phases — container creation, media-processing polls, validation —
 * prove no post exists and must keep their ordinary retryable behaviour. The
 * providers are what know the phase; this function cannot tell.
 */
export function isIndeterminatePublishError(err: unknown): boolean {
  if (isAmbiguousPublishError(err)) return true;
  if (!err) return false;

  // 1. A concrete socket/DNS code is the most reliable evidence there is, and it
  //    OVERRIDES the message — a bare "fetch failed" wrapping ECONNREFUSED
  //    provably never reached the platform.
  const cause = (err as { cause?: { code?: unknown } }).cause;
  const causeCode = typeof cause?.code === "string" ? cause.code : undefined;
  if (causeCode) {
    if (SAFE_CONNECT_CODES.has(causeCode)) return false;
    return true;
  }

  const message =
    typeof (err as { message?: unknown }).message === "string"
      ? ((err as { message: string }).message)
      : String(err);

  // 2. Meta's own transience signal. `is_transient` is Meta telling us the call
  //    may have partially succeeded; before this fix the field was read nowhere
  //    in the codebase and that is precisely how the duplicates happened.
  const metaError = parseMetaError(message);
  if (metaError) {
    if (metaError.is_transient === true) return true;
    // code 2 = "API Service" / transient downtime. Deliberately NOT code 1:
    // Meta reuses code 1 for permanent app-config faults (the observed
    // "app is configured as a desktop app"), so only is_transient promotes those.
    if (metaError.code === 2) return true;
    // Any other structured Meta error is a definite rejection (auth, permission,
    // bad metric, validation). Return here so a random digit run inside
    // `fbtrace_id` can never reach the loose message patterns below.
    return false;
  }

  // 3. No structured error — fall back to transport-level message shapes.
  return INDETERMINATE_MESSAGE_PATTERNS.some((re) => re.test(message));
}
