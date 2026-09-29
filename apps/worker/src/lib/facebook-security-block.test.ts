/**
 * Facebook code:368/subcode:1404112 ("For security reasons, your account has
 * limited access to the site for a few days") was classified as `rate_limit`
 * — the same bucket as a genuine spam-throttle — and retried every 30
 * minutes forever. Measured on prod (post cmulhowhx0003n50i4htdhlsr,
 * 2026-09-28/29): one Facebook target retried 20+ times over 9+ hours,
 * every attempt returning the IDENTICAL code:368/subcode:1404112 body, none
 * ever succeeding (Meta's own message says "a few days" — no retry cadence
 * on our side resolves it).
 *
 * Because the post-completion check (post-publish.worker.ts) requires EVERY
 * target to reach a terminal state (PUBLISHED or FAILED) before it will send
 * the publish-report email, this one perpetually-retrying, never-terminal
 * target silently withheld the report for the OTHER 235 channels that had
 * already published successfully hours earlier — the user's complaint
 * ("links on 240 pages not received on mail") traces directly to this.
 *
 * Fix: this specific, identifiable subcode is a DEFINITE, long-duration
 * account-level restriction, not a transient rate limit — classify it as
 * `permission` (terminal) so the target is marked FAILED immediately with an
 * actionable message, instead of retried forever. The bare/generic
 * `code":368` case (no distinguishing subcode/phrase) is UNCHANGED — this
 * fix does not claim every code-368 body is definite, only this specific,
 * evidenced one.
 */
import { describe, it, expect } from "vitest";
import { classifyError } from "./publish-recovery";

// The exact (de-identified) production error body.
const PROD_SECURITY_BLOCK =
  '{"error":{"message":"For security reasons, your account has limited access to the site for a few days. If you have any questions, please contact our Help Centre.","type":"OAuthException","code":368,"error_data":{"sentry_block_data":"redacted","help_center_id":0,"is_silent":false},"error_subcode":1404112,"error_user_msg":"","fbtrace_id":"Ao-RjFYKVHbG81B3LVUYmkN"}}';

describe("classifyError — Facebook code:368/subcode:1404112 is a DEFINITE account restriction", () => {
  it("classifies the real production security-block body as permission, not rate_limit", () => {
    expect(classifyError(PROD_SECURITY_BLOCK)).toBe("permission");
  });

  it("still recognizes the phrase alone (subcode absent from the substring match, wording present)", () => {
    expect(
      classifyError('{"error":{"code":368,"message":"your account has limited access to the site for a few days"}}')
    ).toBe("permission");
  });

  it("a bare/generic code:368 with no distinguishing subcode or phrase is UNCHANGED (still rate_limit)", () => {
    expect(classifyError('{"error":{"code":368}}')).toBe("rate_limit");
  });

  it("does not affect the other confirmed-transient throttle codes", () => {
    expect(classifyError('{"error":{"message":"(#4) Application request limit reached","code":4}}')).toBe(
      "rate_limit"
    );
    expect(classifyError('{"errors":[{"code":32}]}')).toBe("rate_limit");
  });
});
