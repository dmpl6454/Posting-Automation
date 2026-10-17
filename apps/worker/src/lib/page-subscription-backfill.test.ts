import { describe, it, expect, vi } from "vitest";
import {
  backfillWanted,
  runPageSubscriptionBackfill,
  BACKFILL_MAX_LISTINGS,
  BACKFILL_MAX_PAGES,
  type BackfillChannel,
} from "./page-subscription-backfill";

const NOW = new Date("2026-10-18T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

const fb = (id: string, pageId: string, extra: Partial<BackfillChannel> = {}): BackfillChannel => ({
  id,
  platform: "FACEBOOK",
  platformId: pageId,
  accessToken: `page-token-${pageId}`,
  metaAppId: null,
  metadata: { pageId },
  ...extra,
});
const ig = (id: string, igUserId: string, token = "user-token", extra: Partial<BackfillChannel> = {}): BackfillChannel => ({
  id,
  platform: "INSTAGRAM",
  platformId: igUserId,
  accessToken: token,
  metaAppId: null,
  metadata: { igUserId },
  ...extra,
});

function harness(channels: BackfillChannel[], overrides: Record<string, any> = {}) {
  const records: Array<{ id: string; outcome: any }> = [];
  const deps = {
    channels,
    resolveAppId: vi.fn(() => "APP"),
    subscribe: vi.fn(async (i: any) => ({ pageId: i.pageId, status: "subscribed" as const })),
    listLinkedPages: vi.fn(async () => ({ ok: true, pages: [] as any[] })),
    record: vi.fn(async (id: string, outcome: any) => {
      records.push({ id, outcome });
    }),
    now: () => NOW,
    ...overrides,
  };
  return { deps, records };
}

describe("backfillWanted", () => {
  it("skips, with no call, channels that cannot succeed", () => {
    expect(backfillWanted(fb("c", "1", { accessToken: null }), NOW)).toBe(false);
    expect(backfillWanted(fb("c", "1", { accessToken: "disconnected" }), NOW)).toBe(false);
    expect(backfillWanted(fb("c", "1", { accessToken: "enc:v1:abc" }), NOW)).toBe(false);
    expect(backfillWanted(fb("c", "1", { metadata: { insightsHealth: { status: "needs_reconnect" } } }), NOW)).toBe(false);
    expect(backfillWanted(fb("c", "1", { metadata: { grantedScopes: ["pages_show_list"] } }), NOW)).toBe(false);
  });

  it("tries an unknown grant, and one that includes the permission", () => {
    expect(backfillWanted(fb("c", "1"), NOW)).toBe(true);
    expect(backfillWanted(fb("c", "1", { metadata: { grantedScopes: ["pages_manage_metadata"] } }), NOW)).toBe(true);
  });

  it("cools a failure down for a week and re-checks a success monthly", () => {
    const at = (status: string, d: number) => fb("c", "1", { metadata: { pageSubscription: { status, at: daysAgo(d) } } });
    expect(backfillWanted(at("failed", 3), NOW)).toBe(false);
    expect(backfillWanted(at("missing_permission", 8), NOW)).toBe(true);
    expect(backfillWanted(at("subscribed", 20), NOW)).toBe(false);
    expect(backfillWanted(at("already", 31), NOW)).toBe(true);
    expect(backfillWanted(fb("c", "1", { metadata: { pageSubscription: { status: "failed", at: "garbage" } } }), NOW)).toBe(true);
  });
});

describe("runPageSubscriptionBackfill", () => {
  it("subscribes a Facebook Page once for every workspace that holds it, with the Page token", async () => {
    const { deps, records } = harness([fb("a", "111"), fb("b", "111"), fb("c", "222")]);
    const s = await runPageSubscriptionBackfill(deps);
    expect(deps.subscribe).toHaveBeenCalledTimes(2);
    expect(deps.subscribe).toHaveBeenCalledWith({ pageId: "111", pageAccessToken: "page-token-111", appId: "APP" });
    expect(records.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect(records[0]!.outcome).toEqual({ status: "subscribed", at: NOW.toISOString() });
    expect(s).toMatchObject({ eligible: 3, subscribed: 2, listings: 0 });
  });

  it("resolves an Instagram account's Page through ONE listing per user token, merged with its FB channel", async () => {
    const { deps, records } = harness([fb("f", "111"), ig("i1", "17841", "U"), ig("i2", "17842", "U")], {
      listLinkedPages: vi.fn(async () => ({
        ok: true,
        pages: [
          { pageId: "111", pageAccessToken: "from-listing", igUserId: "17841" },
          { pageId: "333", pageAccessToken: "p333", igUserId: "17842" },
        ],
      })),
    });
    await runPageSubscriptionBackfill(deps);
    expect(deps.listLinkedPages).toHaveBeenCalledTimes(1);
    expect(deps.listLinkedPages).toHaveBeenCalledWith("U");
    expect(deps.subscribe.mock.calls.map((c: any[]) => c[0].pageId).sort()).toEqual(["111", "333"]);
    expect(records.map((r) => r.id).sort()).toEqual(["f", "i1", "i2"]);
  });

  it("records why an Instagram channel could not be resolved, and does not subscribe anything for it", async () => {
    const { deps, records } = harness([ig("dead", "1", "T1"), ig("missing", "2", "T2")], {
      listLinkedPages: vi.fn(async (t: string) =>
        t === "T1" ? { ok: false, pages: [], reason: "#190" } : { ok: true, pages: [{ pageId: "9", pageAccessToken: "x", igUserId: "999" }] }
      ),
    });
    await runPageSubscriptionBackfill(deps);
    expect(deps.subscribe).not.toHaveBeenCalled();
    expect(records.find((r) => r.id === "dead")!.outcome).toMatchObject({ status: "failed", reason: "could not list Pages (#190)" });
    expect(records.find((r) => r.id === "missing")!.outcome).toMatchObject({ status: "failed", reason: "linked Page not granted to this login" });
  });

  it("skips an unconfigured Meta app without a call or a stamp", async () => {
    const { deps, records } = harness([fb("a", "1")], { resolveAppId: vi.fn(() => null) });
    const s = await runPageSubscriptionBackfill(deps);
    expect(deps.subscribe).not.toHaveBeenCalled();
    expect(records).toEqual([]);
    expect(s.eligible).toBe(0);
  });

  it("keeps two Meta apps apart for the same Page", async () => {
    const { deps } = harness([fb("a", "1", { metaAppId: "B" }), fb("b", "1")], {
      resolveAppId: vi.fn((_p: string, id: string | null) => id ?? "A"),
    });
    await runPageSubscriptionBackfill(deps);
    expect(deps.subscribe.mock.calls.map((c: any[]) => c[0].appId).sort()).toEqual(["A", "B"]);
  });

  it("caps Page subscriptions and listings per run, leaving the rest unstamped for later", async () => {
    const fbs = Array.from({ length: BACKFILL_MAX_PAGES + 5 }, (_, i) => fb(`f${i}`, String(1000 + i)));
    const igs = Array.from({ length: BACKFILL_MAX_LISTINGS + 2 }, (_, i) => ig(`i${i}`, String(5000 + i), `tok${i}`));
    const { deps, records } = harness([...fbs, ...igs], {
      listLinkedPages: vi.fn(async () => ({ ok: true, pages: [] })),
    });
    const s = await runPageSubscriptionBackfill(deps);
    expect(deps.listLinkedPages).toHaveBeenCalledTimes(BACKFILL_MAX_LISTINGS);
    expect(deps.subscribe).toHaveBeenCalledTimes(BACKFILL_MAX_PAGES);
    expect(s.deferred).toBe(5 + 2);
    // Freshest-first: the first channels in the list are the ones served.
    expect(records.some((r) => r.id === "f0")).toBe(true);
    expect(records.some((r) => r.id === `f${BACKFILL_MAX_PAGES + 4}`)).toBe(false);
  });

  it("never throws, even when every dependency does", async () => {
    const boom = vi.fn(async () => {
      throw new Error("x");
    });
    const { deps } = harness([fb("a", "1"), ig("i", "2")], { subscribe: boom, listLinkedPages: boom, record: boom });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runPageSubscriptionBackfill(deps)).resolves.toMatchObject({ eligible: 2, failed: 2 });
    // Per-item failures are absorbed; the run itself never aborts.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("run failed"))).toBe(false);
    warn.mockRestore();
  });
});
