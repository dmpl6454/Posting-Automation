import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * CLAUDE.md records an invariant: Super Agent's `get_analytics` returns engagement
 * from "the SAME source as analytics.engagement, so chat and dashboard agree".
 *
 * It stopped being true silently. `analytics.engagement` was rewritten to use the
 * shared `fetchChannelStatRows` aggregate, while chat kept a private copy of the
 * old SQL over AnalyticsSnapshot. That copy then drifted THREE ways at once:
 *
 *   1. it missed platform-native (direct) posts — then the LARGER population, ~5x
 *      more rows than app-published on this deployment. ⚠️ INVERTED 2026-08-19:
 *      direct posts are now deliberately EXCLUDED from Insights (owner decision),
 *      so sharing the aggregate is what keeps chat excluding them too. The parity
 *      requirement is unchanged — only the direction of the drift it prevents;
 *   2. it applied no capability gate, so it reported a number for Instagram
 *      impressions while the dashboard rendered "—" for the same data;
 *   3. it never learned about `views`.
 *
 * Prose invariants do not hold. This locks it at the source level — the same
 * technique external-video-budget.test.ts uses — because a behavioural test would
 * need the whole tRPC context stood up, and the thing worth preventing is
 * precisely someone reintroducing a parallel query.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const chatSrc = readFileSync(join(ROOT, "packages/api/src/routers/chat.router.ts"), "utf8");

/** Code with comments stripped — the prohibitions below are about CODE. */
const chatCode = chatSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");

describe("Super Agent get_analytics must share the dashboard's aggregate", () => {
  it("uses fetchChannelStatRows rather than its own query", () => {
    expect(chatCode).toMatch(/fetchChannelStatRows\(/);
  });

  it("🔴 has NO private SQL over AnalyticsSnapshot — that is how the drift happened", () => {
    expect(chatCode).not.toMatch(/FROM\s+"AnalyticsSnapshot"/i);
    expect(chatCode).not.toMatch(/SUM\(a\.impressions\)/i);
  });

  it("applies the capability gate, so it cannot report a metric the platform never sends", () => {
    // Without this, chat states a confident number for Instagram impressions
    // (a metric Meta deleted) while the dashboard correctly renders "—".
    expect(chatCode).toMatch(/effectiveChannelUnavailable\(/);
  });

  it("includes views — the metric the dashboard now leads with", () => {
    expect(chatCode).toMatch(/views:\s*sumGated\("views"\)/);
  });

  it("states its window instead of implying an all-time figure", () => {
    // The old copy summed every published target ever and labelled it
    // "all published posts"; the dashboard defaults to 30 days.
    expect(chatSrc).toMatch(/last 30 days/);
  });

  it("does not print a metric whose gated total is zero", () => {
    // A structurally-absent metric (IG clicks, IG impressions) must not appear as
    // "0" in the agent's summary — that is the confident-zero the honesty layer
    // exists to prevent, restated in prose by the model.
    expect(chatCode).toMatch(/\.filter\(\(\[, v\]\) => v > 0\)/);
  });
});
