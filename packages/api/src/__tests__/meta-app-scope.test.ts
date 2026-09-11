import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { metaAppChannelScope } from "../lib/meta-app-scope";
import { markChannelsMissingFromGrant } from "../lib/orphaned-grant";

const APP_A = "298449321694397";
const APP_B = "259982148841906";

const KEYS = [
  "FACEBOOK_CLIENT_ID",
  "FACEBOOK_CLIENT_SECRET",
  "INSTAGRAM_CLIENT_ID",
  "INSTAGRAM_CLIENT_SECRET",
  "META_APP_2_ID",
  "META_APP_2_SECRET",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FACEBOOK_CLIENT_ID = APP_A;
  process.env.FACEBOOK_CLIENT_SECRET = "secret-a";
  process.env.INSTAGRAM_CLIENT_ID = APP_A;
  process.env.INSTAGRAM_CLIENT_SECRET = "secret-a";
  process.env.META_APP_2_ID = APP_B;
  process.env.META_APP_2_SECRET = "secret-b";
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("metaAppChannelScope", () => {
  // 🔴 Legacy rows carry metaAppId = NULL. In SQL `x IN (NULL,'a')` never
  // matches a NULL row, so this MUST be an explicit OR — an `in` containing
  // null would silently exclude every pre-existing channel.
  it("expands the legacy app to (NULL OR its id)", () => {
    expect(metaAppChannelScope("FACEBOOK", APP_A)).toEqual({
      OR: [{ metaAppId: null }, { metaAppId: APP_A }],
    });
  });

  it("never emits an `in` filter (which cannot match NULL)", () => {
    const scope = metaAppChannelScope("FACEBOOK", APP_A);
    expect(JSON.stringify(scope)).not.toContain('"in"');
  });

  it("matches a non-legacy app exactly, and NOT the NULL rows", () => {
    const scope = metaAppChannelScope("FACEBOOK", APP_B);
    expect(scope).toEqual({ metaAppId: APP_B });
    expect(JSON.stringify(scope)).not.toContain("null");
  });

  it("treats the legacy app as legacy for both Meta platforms", () => {
    expect(metaAppChannelScope("INSTAGRAM", APP_A)).toEqual({
      OR: [{ metaAppId: null }, { metaAppId: APP_A }],
    });
  });

  // 🔴 Prisma reads `where: { metaAppId: undefined }` as NO FILTER, widening
  // the query to every channel instead of narrowing it. tsc cannot catch it
  // because Prisma types the field optional — so this throws instead.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace", "   "],
    ["a number", 123],
  ])("throws rather than produce a no-op filter for %s", (_label, bad) => {
    expect(() => metaAppChannelScope("FACEBOOK", bad as string)).toThrow(/non-empty string/);
  });

  it("still scopes to the exact id when the legacy app is unconfigured", () => {
    delete process.env.FACEBOOK_CLIENT_ID;
    delete process.env.FACEBOOK_CLIENT_SECRET;
    expect(metaAppChannelScope("FACEBOOK", APP_B)).toEqual({ metaAppId: APP_B });
  });
});

describe("markChannelsMissingFromGrant — app scoping", () => {
  function fakePrisma(rows: Array<{ id: string; platformId: string; metadata: unknown }>) {
    const findMany = vi.fn().mockResolvedValue(rows);
    const update = vi.fn().mockResolvedValue({});
    return { prisma: { channel: { findMany, update } }, findMany, update };
  }

  const needsReconnect = (id: string, platformId: string) => ({
    id,
    platformId,
    metadata: {
      insightsHealth: { status: "needs_reconnect", reason: "token_invalid", checkedAt: "x" },
    },
  });

  // 🔴 The scope must reach the QUERY. Applying it after `take` would let the
  // other app's rows consume the cap and push this app's genuine orphans out
  // of the result entirely.
  it("applies the app scope inside the findMany WHERE, not after", async () => {
    const { prisma, findMany } = fakePrisma([]);
    await markChannelsMissingFromGrant(
      prisma as never,
      "org1",
      "FACEBOOK",
      ["page-1"],
      "Facebook",
      undefined,
      metaAppChannelScope("FACEBOOK", APP_B)
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0]![0].where;
    expect(where.metaAppId).toBe(APP_B);
    // The cap is still present — the scope narrows the candidate set BEFORE it.
    expect(findMany.mock.calls[0]![0].take).toBeGreaterThan(0);
  });

  it("scopes a legacy consent to NULL-or-legacy rows", async () => {
    const { prisma, findMany } = fakePrisma([]);
    await markChannelsMissingFromGrant(
      prisma as never,
      "org1",
      "FACEBOOK",
      ["page-1"],
      "Facebook",
      undefined,
      metaAppChannelScope("FACEBOOK", APP_A)
    );
    expect(findMany.mock.calls[0]![0].where.OR).toEqual([
      { metaAppId: null },
      { metaAppId: APP_A },
    ]);
  });

  // Backward-compat: the parameter is optional, so existing callers that pass
  // nothing keep the exact pre-multi-app query.
  it("omits the scope entirely when no appScope is supplied", async () => {
    const { prisma, findMany } = fakePrisma([]);
    await markChannelsMissingFromGrant(prisma as never, "org1", "FACEBOOK", ["page-1"], "Facebook");
    const where = findMany.mock.calls[0]![0].where;
    expect(where).not.toHaveProperty("metaAppId");
    expect(where).not.toHaveProperty("OR");
  });

  it("still stamps the orphans the scoped query returns", async () => {
    const { prisma, update } = fakePrisma([needsReconnect("c1", "page-2")]);
    const n = await markChannelsMissingFromGrant(
      prisma as never,
      "org1",
      "FACEBOOK",
      ["page-1"],
      "Facebook",
      undefined,
      metaAppChannelScope("FACEBOOK", APP_B)
    );
    expect(n).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the grant is empty (unchanged guard)", async () => {
    const { prisma, findMany } = fakePrisma([]);
    const n = await markChannelsMissingFromGrant(
      prisma as never,
      "org1",
      "FACEBOOK",
      [],
      "Facebook",
      undefined,
      metaAppChannelScope("FACEBOOK", APP_B)
    );
    expect(n).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
