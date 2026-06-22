/**
 * isSeedNoise (2026-06-22) — the demo seed (`pnpm db:seed`) creates posts
 * seed-post-001..00N targeting demo channels with fake `demo-access-token-*`
 * credentials. Publishing them always 401s → token_expired ErrorLog rows that
 * pollute Monitoring with non-bugs. We skip the ErrorLog write for these.
 *
 * Real posts use cuid ids (never the `seed-post-` prefix), so the predicate
 * cannot false-positive on production failures.
 */
import { describe, it, expect } from "vitest";
import { isSeedNoise } from "../../lib/publish-recovery";

describe("isSeedNoise", () => {
  it("flags seed-post job data", () => {
    expect(isSeedNoise({ postId: "seed-post-001" })).toBe(true);
    expect(isSeedNoise({ postId: "seed-post-005" })).toBe(true);
  });

  it("does not flag real cuid post ids", () => {
    expect(isSeedNoise({ postId: "clr9k2x4p0001abcd1234efgh" })).toBe(false);
    expect(isSeedNoise({ postId: "post_abc123" })).toBe(false);
  });

  it("is safe on missing/empty postId", () => {
    expect(isSeedNoise({ postId: "" })).toBe(false);
    expect(isSeedNoise({} as any)).toBe(false);
  });
});
