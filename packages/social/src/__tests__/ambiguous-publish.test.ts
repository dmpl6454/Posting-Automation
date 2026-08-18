import { describe, it, expect } from "vitest";
import {
  AmbiguousPublishError,
  isAmbiguousPublishError,
  isIndeterminatePublishError,
} from "../utils/ambiguous-publish";

/**
 * The 2026-08-13 duplicate-post incident in one sentence: Instagram's
 * `media_publish` returned `code: 2, is_transient: true` while HAVING ACTUALLY
 * CREATED the post, the worker recorded FAILED, and every retry layer re-created
 * it — 11 of 11 "failed" targets were live and one account received 5 copies.
 *
 * These tests pin the classification that decides whether a retry is allowed to
 * re-run a non-idempotent create. The asymmetry is deliberate and load-bearing:
 *   - a wrong "indeterminate" costs the user one manual re-publish;
 *   - a wrong "definitely failed" costs them a duplicate post on a live account.
 * When in doubt the answer must be indeterminate.
 */
describe("AmbiguousPublishError", () => {
  it("is recognised through a duck-typed flag, not instanceof", () => {
    const err = new AmbiguousPublishError("boom");
    expect(isAmbiguousPublishError(err)).toBe(true);
    // Duck typing matters: provider and worker can resolve different copies of
    // this module under pnpm's isolated layout, which breaks instanceof.
    expect(isAmbiguousPublishError({ isAmbiguousPublish: true, message: "x" })).toBe(true);
  });

  it("does not treat ordinary errors as ambiguous", () => {
    expect(isAmbiguousPublishError(new Error("nope"))).toBe(false);
    expect(isAmbiguousPublishError(null)).toBe(false);
    expect(isAmbiguousPublishError(undefined)).toBe(false);
    expect(isAmbiguousPublishError("string")).toBe(false);
  });

  it("carries the platform and preserves the message", () => {
    const err = new AmbiguousPublishError("may have published", { platform: "INSTAGRAM" });
    expect(err.platform).toBe("INSTAGRAM");
    expect(err.message).toBe("may have published");
    expect(err.name).toBe("AmbiguousPublishError");
  });
});

describe("isIndeterminatePublishError — Meta payloads", () => {
  it("treats is_transient:true as indeterminate (the exact 2026-08-13 error)", () => {
    const real =
      'Instagram publish failed: {"error":{"message":"An unexpected error has occurred. ' +
      'Please retry your request later.","type":"OAuthException","is_transient":true,' +
      '"code":2,"fbtrace_id":"AXgtZxIYulREP10R9zhI_dx"}}';
    expect(isIndeterminatePublishError(new Error(real))).toBe(true);
  });

  it("treats Meta code 2 as indeterminate even without is_transient", () => {
    expect(
      isIndeterminatePublishError(new Error('Facebook post failed: {"error":{"code":2}}'))
    ).toBe(true);
  });

  it("does NOT treat a definite Meta config/auth error as indeterminate", () => {
    // Meta code 1 is genuinely ambiguous in the abstract, but this exact prod
    // error is a permanent app-config fault; only is_transient may promote it.
    const cfg =
      'Facebook long-lived token exchange failed: {"error":{"message":"The request is ' +
      'invalid because the app is configured as a desktop app","type":"OAuthException","code":1}}';
    expect(isIndeterminatePublishError(new Error(cfg))).toBe(false);
  });

  it("does NOT treat token/permission/validation errors as indeterminate", () => {
    for (const m of [
      'Instagram publish failed: {"error":{"code":190,"message":"Error validating access token"}}',
      'Facebook post failed: {"error":{"code":10,"message":"permission denied"}}',
      "Validation failed: Instagram requires at least one image",
      'Instagram media processing failed: ERROR',
    ]) {
      expect(isIndeterminatePublishError(new Error(m)), m).toBe(false);
    }
  });

  it("must not be fooled by a digit sequence inside fbtrace_id", () => {
    // classifyError's substring matching is why an fbtrace_id can misroute an
    // error; this classifier must key on the structured code, not loose digits.
    const trace =
      'Instagram publish failed: {"error":{"message":"Unsupported post request",' +
      '"code":100,"fbtrace_id":"A2xx401x403x32x"}}';
    expect(isIndeterminatePublishError(new Error(trace))).toBe(false);
  });
});

describe("isIndeterminatePublishError — network failures", () => {
  it("treats a mid-flight socket failure as indeterminate", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]) {
      const err: any = new Error("fetch failed");
      err.cause = { code };
      expect(isIndeterminatePublishError(err), code).toBe(true);
    }
  });

  it("treats connect/DNS failures as DEFINITELY failed — the request never left", () => {
    // This is the whole point of inspecting cause.code: ECONNREFUSED and
    // ENOTFOUND prove no request reached the platform, so retrying is safe and
    // must stay safe (otherwise a DNS blip would strand posts as ambiguous).
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
      const err: any = new Error("fetch failed");
      err.cause = { code };
      expect(isIndeterminatePublishError(err), code).toBe(false);
    }
  });

  it("treats a bare 'fetch failed' with no cause as indeterminate", () => {
    expect(isIndeterminatePublishError(new Error("fetch failed"))).toBe(true);
  });

  it("treats an aborted/timed-out request as indeterminate", () => {
    for (const m of [
      "The operation was aborted due to timeout",
      "socket hang up",
      "terminated",
      "Request timed out after 25000ms",
    ]) {
      expect(isIndeterminatePublishError(new Error(m)), m).toBe(true);
    }
  });

  it("an already-ambiguous error stays indeterminate", () => {
    expect(isIndeterminatePublishError(new AmbiguousPublishError("x"))).toBe(true);
  });
});
