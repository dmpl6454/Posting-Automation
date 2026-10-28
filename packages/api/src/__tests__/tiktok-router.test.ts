/**
 * tiktok.creatorInfo — the live "what can this TikTok account do right now"
 * read that Compose shows before a TikTok post (2026-10-28).
 *
 * Exercises the REAL router through a tRPC caller with a mocked prisma, a mocked
 * provider (token refresh) and a stubbed fetch (creator_info/query). Locks:
 *   - the channel is read DIRECTLY (prisma.channel.findFirst — the only read
 *     path that decrypts the token) and scoped to org + TIKTOK + connected;
 *   - TikTok's body never reaches the caller — fixed-text reasons/errors only;
 *   - an expiring token is refreshed first and persisted with a CONDITIONAL
 *     update (a concurrent refresh is not overwritten);
 *   - a per-user limit and a per-account budget (TikTok allows 20/min per
 *     token and the publish worker shares it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refreshAccessToken = vi.fn();
vi.mock("@postautomation/social", () => ({
  getSocialProvider: vi.fn((platform: string) => {
    if (platform !== "TIKTOK") throw new Error("unexpected provider");
    return { refreshAccessToken };
  }),
}));

const channelFindFirst = vi.fn();
const channelUpdateMany = vi.fn();
vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async () => ({ id: "m1", userId: "u", organizationId: "org-1", role: "OWNER" })),
      findFirst: vi.fn(async () => ({ organizationId: "org-1" })),
    },
    organization: { findUnique: vi.fn(async () => ({ plan: "FREE", planExpiresAt: null })) },
    channel: {
      findFirst: (...a: any[]) => channelFindFirst(...a),
      updateMany: (...a: any[]) => channelUpdateMany(...a),
    },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { tiktokRouter } from "../routers/tiktok.router";
import { prisma as prismaMock } from "@postautomation/db";

let userSeq = 0;
function caller(userId = `user-${++userSeq}`) {
  return createCallerFactory(tiktokRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: { user: { id: userId, email: "u@example.com", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });
}

let accountSeq = 0;
function channel(over: Record<string, unknown> = {}) {
  return {
    id: "chan-tt",
    organizationId: "org-1",
    platform: "TIKTOK",
    platformId: `open-${++accountSeq}`,
    name: "Studio One",
    accessToken: "act.old",
    refreshToken: "rft.old",
    tokenExpiresAt: new Date(Date.now() + 6 * 3600_000),
    disconnectedAt: null,
    ...over,
  };
}

const creatorData = {
  creator_avatar_url: "https://p16.tiktokcdn.com/a.jpg",
  creator_username: "studio.one",
  creator_nickname: "Studio One",
  privacy_level_options: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 600,
};

let fetchMock: ReturnType<typeof vi.fn>;
function respond(status: number, body: unknown) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  respond(200, { data: creatorData, error: { code: "ok", message: "", log_id: "20261028401403" } });
  channelUpdateMany.mockResolvedValue({ count: 1 });
  process.env.TIKTOK_CLIENT_ID = "ck";
  process.env.TIKTOK_CLIENT_SECRET = "cs";
});
afterEach(() => vi.unstubAllGlobals());

describe("tiktok.creatorInfo — channel scoping", () => {
  it("reads the channel DIRECTLY, scoped to org + TikTok + connected", async () => {
    channelFindFirst.mockResolvedValue(channel());
    await caller().creatorInfo({ channelId: "chan-tt" });
    expect(channelFindFirst).toHaveBeenCalledWith({
      where: { id: "chan-tt", organizationId: "org-1", platform: "TIKTOK", disconnectedAt: null },
    });
  });

  it("is NOT_FOUND for a foreign, non-TikTok or disconnected channel — and calls nothing", async () => {
    channelFindFirst.mockResolvedValue(null);
    await expect(caller().creatorInfo({ channelId: "other" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tiktok.creatorInfo — answers", () => {
  it("returns the creator's live options with the stored token", async () => {
    channelFindFirst.mockResolvedValue(channel());
    const res = await caller().creatorInfo({ channelId: "chan-tt" });
    expect(res).toEqual({
      creator: {
        nickname: "Studio One",
        username: "studio.one",
        avatarUrl: "https://p16.tiktokcdn.com/a.jpg",
        privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
        commentDisabled: false,
        duetDisabled: true,
        stitchDisabled: false,
        maxVideoPostDurationSec: 600,
      },
      canPost: true,
      reason: null,
    });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer act.old" });
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("a can't-post code ⇒ canPost false with OUR text, never TikTok's", async () => {
    channelFindFirst.mockResolvedValue(channel());
    respond(200, { data: {}, error: { code: "spam_risk_too_many_posts", message: "SECRET-TIKTOK-TEXT", log_id: "401" } });
    const res = await caller().creatorInfo({ channelId: "chan-tt" });
    expect(res.canPost).toBe(false);
    expect(res.creator).toBeNull();
    expect(res.reason).toMatch(/TikTok/);
    expect(JSON.stringify(res)).not.toMatch(/SECRET-TIKTOK-TEXT|log_id/);
  });

  it("a dead token or missing scope ⇒ a fixed 'Reconnect' error", async () => {
    channelFindFirst.mockResolvedValue(channel());
    respond(401, { data: {}, error: { code: "access_token_invalid", message: "SECRET-TIKTOK-TEXT", log_id: "9" } });
    const err: any = await caller().creatorInfo({ channelId: "chan-tt" }).catch((e) => e);
    expect(err.message).toMatch(/^Reconnect this TikTok account/);
    expect(err.message).not.toMatch(/SECRET/);
  });

  it("anything else ⇒ a fixed 'Couldn't reach TikTok' error", async () => {
    channelFindFirst.mockResolvedValue(channel());
    respond(500, { data: {}, error: { code: "internal_error", message: "SECRET-TIKTOK-TEXT", log_id: "1" } });
    const err: any = await caller().creatorInfo({ channelId: "chan-tt" }).catch((e) => e);
    expect(err.message).toBe("Couldn't reach TikTok — try again.");
  });
});

describe("tiktok.creatorInfo — token refresh", () => {
  it("refreshes a token expiring within 5 minutes, persists it CONDITIONALLY, and uses it", async () => {
    const expiring = new Date(Date.now() + 2 * 60_000);
    channelFindFirst.mockResolvedValue(channel({ tokenExpiresAt: expiring }));
    const newExpiry = new Date(Date.now() + 24 * 3600_000);
    refreshAccessToken.mockResolvedValue({ accessToken: "act.new", refreshToken: "rft.new", expiresAt: newExpiry });

    await caller().creatorInfo({ channelId: "chan-tt" });

    expect(refreshAccessToken).toHaveBeenCalledWith("rft.old", expect.objectContaining({ clientId: "ck", clientSecret: "cs" }));
    expect(channelUpdateMany).toHaveBeenCalledWith({
      // disconnectedAt: a disconnect while this refresh was in flight must win —
      // live credentials are never written back onto a disconnected channel.
      where: { id: "chan-tt", organizationId: "org-1", tokenExpiresAt: expiring, disconnectedAt: null },
      data: { accessToken: "act.new", refreshToken: "rft.new", tokenExpiresAt: newExpiry },
    });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer act.new" });
  });

  it("keeps the stored refresh token when TikTok returns none", async () => {
    channelFindFirst.mockResolvedValue(channel({ tokenExpiresAt: new Date(Date.now() - 1000) }));
    refreshAccessToken.mockResolvedValue({ accessToken: "act.new", expiresAt: new Date(Date.now() + 3600_000) });
    await caller().creatorInfo({ channelId: "chan-tt" });
    expect(channelUpdateMany.mock.calls[0]![0].data.refreshToken).toBe("rft.old");
  });

  it("a failed refresh falls back to the stored token and never surfaces the refresh error", async () => {
    channelFindFirst.mockResolvedValue(channel({ tokenExpiresAt: new Date(Date.now() - 1000) }));
    refreshAccessToken.mockRejectedValue(new Error('TikTok token refresh failed: {"error":"invalid_grant","log_id":"401"}'));
    respond(401, { data: {}, error: { code: "access_token_invalid", message: "x", log_id: "1" } });
    const err: any = await caller().creatorInfo({ channelId: "chan-tt" }).catch((e) => e);
    expect(err.message).toMatch(/^Reconnect this TikTok account/);
    expect(err.message).not.toMatch(/invalid_grant|log_id/);
    expect(channelUpdateMany).not.toHaveBeenCalled();
  });

  it("two concurrent checks of one channel spend the refresh token ONCE", async () => {
    channelFindFirst.mockResolvedValue(channel({ tokenExpiresAt: new Date(Date.now() - 1000) }));
    let release!: (v: unknown) => void;
    refreshAccessToken.mockImplementation(
      () => new Promise((r) => (release = () => r({ accessToken: "act.new", expiresAt: new Date(Date.now() + 3600_000) })))
    );
    const a = caller().creatorInfo({ channelId: "chan-tt" });
    const b = caller().creatorInfo({ channelId: "chan-tt" });
    await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalled());
    release(undefined);
    await Promise.all([a, b]);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("does not refresh without a refresh token", async () => {
    channelFindFirst.mockResolvedValue(channel({ tokenExpiresAt: new Date(Date.now() - 1000), refreshToken: null }));
    await caller().creatorInfo({ channelId: "chan-tt" });
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });
});

describe("tiktok.creatorInfo — limits", () => {
  it("per user: 200 a minute — an agency selecting 25+ TikTok accounts in Compose is not blocked", async () => {
    // It was 20, so selecting more than 20 TikTok channels at once failed the
    // rest and blocked the whole post. TikTok's budget is per TOKEN, which the
    // per-account limit below protects.
    const c = caller("limit-user");
    for (let i = 0; i < 200; i++) {
      channelFindFirst.mockResolvedValueOnce(channel());
      await c.creatorInfo({ channelId: "chan-tt" });
    }
    await expect(c.creatorInfo({ channelId: "chan-tt" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("per TikTok account, across users: 15 a minute — refused BEFORE calling TikTok", async () => {
    const shared = channel({ platformId: "open-shared" });
    channelFindFirst.mockResolvedValue(shared);
    for (let i = 0; i < 15; i++) await caller().creatorInfo({ channelId: "chan-tt" });
    fetchMock.mockClear();
    await expect(caller().creatorInfo({ channelId: "chan-tt" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
