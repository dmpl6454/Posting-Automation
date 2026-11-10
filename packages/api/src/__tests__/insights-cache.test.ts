/**
 * Insights Redis cache (2026-11-10).
 *
 * Locks: org-scoped keys, hit/miss through the REAL tRPC middleware, version
 * bump invalidation, errors never cached, Redis failure falls through, Date
 * round-trips (superjson), oversize results skipped, mutations never cached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

vi.mock("@postautomation/queue", async () => await import("../../../queue/src/analytics-cache"));

const orgMemberFindUnique = vi.fn();
vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: { findUnique: (...a: any[]) => orgMemberFindUnique(...a), findFirst: vi.fn() },
    organization: { findUnique: vi.fn(async () => ({ plan: "FREE", planExpiresAt: null })) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory, createRouter } from "../trpc";
import { cachedOrgProcedure, insightsInvalidatingOrgProcedure } from "../lib/cached-procedure";
import {
  __setCacheRedisForTests,
  analyticsCacheKey,
  hashInput,
  MAX_CACHE_ENTRY_BYTES,
  withOrgCache,
} from "../lib/cache";
import { prisma as prismaMock } from "@postautomation/db";

/** In-memory stand-in for the ioredis calls the cache makes. */
function fakeRedis(opts: { failGet?: boolean } = {}) {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    store,
    ttl,
    get: vi.fn(async (k: string) => {
      if (opts.failGet) throw new Error("redis down");
      return store.get(k) ?? null;
    }),
    set: vi.fn(async (k: string, v: string, _ex: string, s: number) => {
      store.set(k, v);
      ttl.set(k, s);
      return "OK";
    }),
    multi: () => {
      const ops: Array<() => void> = [];
      const m = {
        incr: (k: string) => {
          ops.push(() => store.set(k, String(Number(store.get(k) ?? 0) + 1)));
          return m;
        },
        expire: (_k: string, _s: number) => m,
        exec: async () => {
          ops.forEach((o) => o());
          return [];
        },
      };
      return m;
    },
  };
}

let compute = vi.fn();
const router = createRouter({
  stats: cachedOrgProcedure
    .input(z.object({ from: z.string().optional() }))
    .query(async ({ input }) => compute(input)),
  touch: insightsInvalidatingOrgProcedure.mutation(async () => ({ ok: true })),
});

function caller(org: string) {
  return createCallerFactory(router)({
    prisma: prismaMock as any,
    organizationId: org,
    session: { user: { id: "u1", email: "a@example.com", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });
}

let redis: ReturnType<typeof fakeRedis>;
beforeEach(() => {
  process.env.ANALYTICS_CACHE_ENABLED = "true";
  redis = fakeRedis();
  __setCacheRedisForTests(redis as any);
  compute = vi.fn(async (input: any) => ({ n: Math.random(), at: new Date("2026-11-10T00:00:00Z"), input }));
  orgMemberFindUnique.mockImplementation(async (a: any) => ({
    id: "m",
    userId: "u1",
    organizationId: a.where.userId_organizationId.organizationId,
    role: "OWNER",
  }));
});
afterEach(() => {
  delete process.env.ANALYTICS_CACHE_ENABLED;
  __setCacheRedisForTests(null);
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("cachedOrgProcedure", () => {
  it("serves the second identical call from cache, with Dates intact", async () => {
    const a = await caller("org-a").stats({ from: "x" });
    const b = await caller("org-a").stats({ from: "x" });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(b.at).toBeInstanceOf(Date);
  });

  it("keys by org: another org never sees the first org's result", async () => {
    await caller("org-a").stats({ from: "x" });
    await caller("org-b").stats({ from: "x" });
    expect(compute).toHaveBeenCalledTimes(2);
    expect([...redis.store.keys()].some((k) => k.includes("org-b"))).toBe(true);
  });

  it("keys by input", async () => {
    await caller("org-a").stats({ from: "x" });
    await caller("org-a").stats({ from: "y" });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("a successful mutation on an invalidating procedure drops the org's cache", async () => {
    await caller("org-a").stats({});
    await caller("org-a").touch();
    await tick();
    await caller("org-a").stats({});
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("never caches an error", async () => {
    compute.mockRejectedValueOnce(new Error("boom"));
    await expect(caller("org-a").stats({})).rejects.toThrow("boom");
    await caller("org-a").stats({});
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("falls through to the query when Redis fails", async () => {
    __setCacheRedisForTests(fakeRedis({ failGet: true }) as any);
    await caller("org-a").stats({});
    await caller("org-a").stats({});
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("uses the short TTL", async () => {
    await caller("org-a").stats({});
    expect([...redis.ttl.values()]).toEqual([120]);
  });

  it("is off when ANALYTICS_CACHE_ENABLED=false", async () => {
    process.env.ANALYTICS_CACHE_ENABLED = "false";
    await caller("org-a").stats({});
    await caller("org-a").stats({});
    expect(compute).toHaveBeenCalledTimes(2);
    expect(redis.store.size).toBe(0);
  });
});

describe("cache helpers", () => {
  it("hashInput ignores key order and undefined", () => {
    expect(hashInput({ a: 1, b: "x", c: undefined })).toBe(hashInput({ b: "x", a: 1 }));
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });

  it("key layout is org then version", () => {
    expect(analyticsCacheKey("o1", "3", "analytics.engagement", {})).toMatch(
      /^cache:analytics:o1:3:analytics\.engagement:[0-9a-f]{20}$/
    );
  });

  it("does not store results larger than the cap", async () => {
    const big = "x".repeat(MAX_CACHE_ENTRY_BYTES + 10);
    await withOrgCache("org-a", "p", {}, async () => big);
    expect(redis.store.size).toBe(0);
  });

  it("is off under vitest unless explicitly enabled", async () => {
    delete process.env.ANALYTICS_CACHE_ENABLED;
    const fn = vi.fn(async () => 1);
    await withOrgCache("org-a", "p", {}, fn);
    await withOrgCache("org-a", "p", {}, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("wiring lock", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const src = readFileSync(join(__dirname, "../routers/analytics.router.ts"), "utf8");
  const cached = ["overview", "engagement", "dashboardStats", "platformBreakdown", "postsOverTime", "perChannelStats", "groupStats", "postReports", "storyInsights", "reportPosts"];
  for (const n of cached) {
    it(`analytics.${n} is cached`, () => expect(src).toContain(`  ${n}: cachedOrgProcedure`));
  }
  // Fresh-by-design: reconnect state, per-target IDOR-checked reads, and every mutation.
  for (const n of ["insightsHealth", "postMetrics", "recentActivity", "triggerSync", "campaignLabels", "platformsInWindow"]) {
    it(`analytics.${n} is NOT cached`, () => expect(src).not.toContain(`  ${n}: cachedOrgProcedure`));
  }
  it("Sync Now invalidates the org's cache", () => {
    expect(src).toMatch(/triggerSync:[\s\S]{0,800}invalidateOrgAnalyticsCache\(ctx\.organizationId\)/);
  });
});
