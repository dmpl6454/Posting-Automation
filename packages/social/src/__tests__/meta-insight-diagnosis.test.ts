import { describe, it, expect } from "vitest";
import {
  diagnoseMetaError,
  diagnoseEmptyInsights,
  extractMissingScopes,
  worstDegradation,
} from "../utils/meta-insight-diagnosis";

/**
 * Locks the classification of Meta insight failures. Every error string below was
 * captured VERBATIM from the live production Graph API on 2026-08-06 while
 * probing the newly-approved insight permissions.
 *
 * The load-bearing assertion is the #100 group: a deleted metric must NEVER be
 * reported as a missing permission, or the UI would tell users to reconnect for
 * data that no permission can ever return.
 */
describe("diagnoseMetaError", () => {
  it("classifies a missing pages_read_user_content (#10) as an actionable missing scope", () => {
    const d = diagnoseMetaError({
      code: 10,
      message:
        "(#10) This endpoint requires the 'pages_read_user_content' permission or the 'Page Public Content Access' feature.",
    });
    expect(d?.reason).toBe("missing_scope");
    expect(d?.missingScopes).toContain("pages_read_user_content");
  });

  it("classifies a missing read_insights (#200) as an actionable missing scope", () => {
    const d = diagnoseMetaError({
      code: 200,
      message: "(#200) read_insights permission missing",
    });
    expect(d?.reason).toBe("missing_scope");
    expect(d?.missingScopes).toContain("read_insights");
  });

  it("classifies an invalidated session (#190) as a dead token", () => {
    const d = diagnoseMetaError({
      code: 190,
      error_subcode: 460,
      message:
        "Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.",
    });
    expect(d?.reason).toBe("token_invalid");
  });

  // ── The critical negative cases ───────────────────────────────────────────
  it("does NOT treat a deleted metric (#100) as a permission problem", () => {
    // VERIFIED: returned for all nine post_impressions* variants EVEN WITH
    // read_insights granted — Meta deleted the metrics at the platform level.
    // Reporting this as `missing_scope` would nag users to reconnect forever.
    expect(
      diagnoseMetaError({ code: 100, message: "(#100) The value must be a valid insights metric" })
    ).toBeUndefined();
  });

  it("does NOT treat an unsupported-for-this-media-type metric (#100) as a permission problem", () => {
    expect(
      diagnoseMetaError({
        code: 100,
        message:
          "(#100) The Media Insights API does not support the profile_visits metric for this media product type.",
      })
    ).toBeUndefined();
  });

  it("does NOT treat a rate limit (#4) as a permission problem", () => {
    expect(diagnoseMetaError({ code: 4, message: "(#4) Application request limit reached" })).toBeUndefined();
  });

  it("returns undefined for a missing error object", () => {
    expect(diagnoseMetaError(undefined)).toBeUndefined();
    expect(diagnoseMetaError(null)).toBeUndefined();
  });
});

describe("extractMissingScopes", () => {
  it("only returns plausible Meta scope names, never arbitrary message words", () => {
    // Platform text is untrusted input — a scope name we surface to the user as
    // "reconnect to grant X" must look like a real Meta scope.
    const scopes = extractMissingScopes(
      "(#10) This endpoint requires the 'pages_read_user_content' permission and the wibble permission"
    );
    expect(scopes).toEqual(["pages_read_user_content"]);
    expect(scopes).not.toContain("wibble");
  });

  it("handles an empty or absent message", () => {
    expect(extractMissingScopes(undefined)).toEqual([]);
    expect(extractMissingScopes("")).toEqual([]);
  });
});

describe("diagnoseEmptyInsights", () => {
  it("flags the SILENT-EMPTY signature: HTTP 200 with zero rows", () => {
    // VERIFIED: a FB token lacking read_insights gets 200 + {"data":[]} — no
    // error at all. This is the ONLY way to detect it, and before it was handled
    // the empty array was stored as "every metric is 0".
    const d = diagnoseEmptyInsights(0, true, "read_insights");
    expect(d?.reason).toBe("missing_scope");
    expect(d?.missingScopes).toEqual(["read_insights"]);
  });

  it("does not flag a response that carried rows", () => {
    expect(diagnoseEmptyInsights(4, true, "read_insights")).toBeUndefined();
  });

  it("does not flag an empty response when no sentinel metric was requested", () => {
    // Without an always-present metric in the set, zero rows is uninformative.
    expect(diagnoseEmptyInsights(0, false, "read_insights")).toBeUndefined();
  });
});

describe("worstDegradation", () => {
  it("prefers a dead token over a missing scope (more actionable)", () => {
    const d = worstDegradation(
      { reason: "missing_scope", missingScopes: ["read_insights"] },
      { reason: "token_invalid" }
    );
    expect(d?.reason).toBe("token_invalid");
  });

  it("unions scope names when two calls each name a different missing scope", () => {
    // One reconnect fixes both, so one prompt should mention both.
    const d = worstDegradation(
      { reason: "missing_scope", missingScopes: ["read_insights"] },
      { reason: "missing_scope", missingScopes: ["pages_read_user_content"] }
    );
    expect(d?.missingScopes).toEqual(["pages_read_user_content", "read_insights"]);
    expect(d?.detail).toContain("pages_read_user_content");
    expect(d?.detail).toContain("read_insights");
  });

  it("returns undefined when nothing degraded", () => {
    expect(worstDegradation(undefined, undefined)).toBeUndefined();
  });
});
