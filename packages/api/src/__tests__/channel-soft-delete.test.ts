import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Locks the SOFT-DELETE contract for channel disconnect (2026-08-06).
 *
 * ⚠️ Why this matters more than a typical wiring test. `PostTarget.channel` is
 * `onDelete: Cascade`, so the previous hard `channel.delete` permanently destroyed
 * every record of posts sent to that channel plus its entire Insights history, and
 * stranded its AnalyticsSnapshot rows forever (AnalyticsSnapshot has NO foreign key
 * to PostTarget, so nothing could ever clean them up). Measured on prod before the
 * change: 329 PUBLISHED + 1262 FAILED + 91 DRAFT posts with zero targets and
 * 1,327,698 unreachable snapshot rows — 111 of those deletions in a single
 * 14-minute window.
 *
 * A regression here silently deletes customer data, so the invariants are asserted
 * against the SOURCE: no `channel.delete`/`deleteMany` may return.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("channel disconnect is a SOFT delete", () => {
  const src = read("packages/api/src/routers/channel.router.ts");

  it("never hard-deletes a Channel row", () => {
    // The whole point: no cascade, so PostTargets and their history survive.
    expect(src).not.toMatch(/prisma\.channel\.delete\s*\(/);
    expect(src).not.toMatch(/prisma\.channel\.deleteMany\s*\(/);
  });

  it("disconnect stamps disconnectedAt, deactivates, and clears the tokens", () => {
    // Clearing tokens matters: a channel the user disconnected must not keep
    // usable platform credentials at rest.
    const block = src.slice(src.indexOf("disconnect: orgProcedure"), src.indexOf("bulkDisconnect:"));
    expect(block).toMatch(/disconnectedAt: new Date\(\)/);
    expect(block).toMatch(/isActive: false/);
    expect(block).toMatch(/accessToken: DISCONNECTED_TOKEN/);
    expect(block).toMatch(/refreshToken: null/);
  });

  it("bulkDisconnect applies the same treatment and skips already-disconnected rows", () => {
    const block = src.slice(src.indexOf("bulkDisconnect: orgProcedure"), src.indexOf("toggleActive:"));
    expect(block).toMatch(/updateMany/);
    expect(block).toMatch(/disconnectedAt: new Date\(\)/);
    expect(block).toMatch(/accessToken: DISCONNECTED_TOKEN/);
    // Idempotent: re-disconnecting must not re-stamp a newer timestamp.
    expect(block).toMatch(/disconnectedAt: null/);
  });

  it("channel.list hides disconnected channels", () => {
    const block = src.slice(src.indexOf("list: orgProcedure"), src.indexOf("recentlyUsed:"));
    expect(block).toMatch(/disconnectedAt: null/);
  });
});

describe("a disconnected channel can never be posted to", () => {
  // Its tokens are cleared, so a queued publish could never succeed — it would
  // just produce a FAILED target and a confusing error for the user.
  it("post.create and post.update exclude disconnected channels from ownership", () => {
    const src = read("packages/api/src/routers/post.router.ts");
    const matches = src.match(/disconnectedAt: null/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("assertChannelsOwned (chat / agent actions) excludes disconnected channels", () => {
    const src = read("packages/api/src/routers/chat.router.ts");
    const fn = src.slice(src.indexOf("export async function assertChannelsOwned"));
    expect(fn.slice(0, 800)).toMatch(/disconnectedAt: null/);
  });
});

describe("reconnect revives the same channel row", () => {
  // This is what preserves history AND stops the duplicate-channel proliferation
  // that disconnect→reconnect used to cause (the same IG account ended up as
  // repeated rows / across 6 orgs).
  it("every OAuth upsert clears disconnectedAt", () => {
    const src = read("apps/web/app/api/oauth/callback/[provider]/route.ts");
    const upserts = (src.match(/isActive: true,/g) ?? []).length;
    const revivals = (src.match(/disconnectedAt: null,/g) ?? []).length;
    expect(upserts).toBeGreaterThan(0);
    // Each site that reactivates a channel must also clear the soft-delete flag,
    // or a reconnected channel would stay invisible and unpostable.
    expect(revivals).toBe(upserts);
  });
});

describe("Insights count history from paused and disconnected channels", () => {
  // Owner decision 2026-08-06 ("count all real history"): a post that WAS
  // published and DID earn engagement is a historical fact. Filtering the stat
  // aggregate on isActive is exactly what made disconnecting erase history.
  const src = read("packages/api/src/routers/analytics.router.ts");

  it("the stat aggregate no longer filters the channel join on isActive", () => {
    expect(src).not.toMatch(/INNER JOIN "Channel" c ON c\.id = pt\."channelId" AND c\."isActive"/);
    expect(src).toMatch(/INNER JOIN "Channel" c ON c\.id = pt\."channelId"/);
  });

  it("emits impressioned-only sums so the rate can be pooled honestly", () => {
    for (const col of [
      "impressionedImpressions",
      "impressionedLikes",
      "impressionedComments",
      "impressionedShares",
      "impressionedPosts",
    ]) {
      expect(src).toContain(col);
    }
    expect(src).toMatch(/FILTER \(WHERE s\.impressions > 0\)/);
  });

  it("exposes the rate's base and the channel's lifecycle status to the UI", () => {
    expect(src).toMatch(/engagementRateBasis/);
    expect(src).toMatch(/channelStatus/);
  });
});
