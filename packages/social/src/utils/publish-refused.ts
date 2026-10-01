/**
 * PublishRefusedError — a publish that was refused BEFORE anything was
 * created, and that retrying cannot fix: the server's address is private, it
 * answered with a redirect, it rejected the credentials, or it rejected the post.
 *
 * ⚠️ Its `name` is deliberately "UnrecoverableError". That is how the publish
 * worker (routePublishError → "terminal") and BullMQ (job.js, name match)
 * recognise a final failure, so:
 *  - the job is not retried;
 *  - the worker's failed handler stores THIS message as-is instead of
 *    re-classifying it (classifyError would read "access token" + "HTTP 401" as
 *    "token expired" and replace the actionable text);
 *  - the target is marked FAILED on the first attempt and the post is finalised.
 * No worker change was needed to get that behaviour. Do not rename it.
 *
 * Contrast with AmbiguousPublishError (./ambiguous-publish.ts): that one means
 * the post MAY already exist. This one means it certainly does not.
 */
export type PublishRefusedReason = "unsafe_destination" | "redirect" | "credentials" | "rejected";

export class PublishRefusedError extends Error {
  readonly isPublishRefused = true as const;
  readonly reason: PublishRefusedReason;
  readonly platform?: string;
  constructor(message: string, opts: { reason: PublishRefusedReason; platform?: string; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "UnrecoverableError";
    this.reason = opts.reason;
    if (opts.platform) this.platform = opts.platform;
  }
}

/** Duck-typed, never instanceof: pnpm can load two copies of this module. */
export function isPublishRefusedError(err: unknown): err is PublishRefusedError {
  return !!err && typeof err === "object" && (err as { isPublishRefused?: unknown }).isPublishRefused === true;
}
