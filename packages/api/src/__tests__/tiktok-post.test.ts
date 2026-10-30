import { describe, it, expect, vi, afterEach } from "vitest";
import {
  tiktokInputSchema,
  tiktokSettingsInputSchema,
  buildTikTokByChannel,
  mergeTikTokByChannel,
  validateTikTokPost,
  queryTikTokCreatorInfo,
  tiktokCannotPostReason,
  TIKTOK_EXACTLY_ONE_VIDEO_MESSAGE,
} from "../lib/tiktok-post";

/**
 * Server-side rules for TikTok posts (2026-10-28). TikTok's Content Sharing
 * Guidelines forbid a default privacy level, so a TikTok target may only be
 * ARMED (scheduled / published) once the user chose its settings, and the
 * settings are per channel because each creator allows different options.
 */

const settings = (over: Record<string, unknown> = {}) => ({
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  brandOrganic: false,
  brandContent: false,
  isAigc: false,
  ...over,
});

const tt = (id: string, name = `tt-${id}`) => ({ id, platform: "TIKTOK", name });
const ig = (id: string) => ({ id, platform: "INSTAGRAM", name: `ig-${id}` });
const video = { fileType: "video/mp4" };

describe("tiktokSettingsInputSchema", () => {
  it("defaults every switch to OFF — the guidelines require interactions off unless the user opts in", () => {
    expect(tiktokSettingsInputSchema.parse({ privacyLevel: "SELF_ONLY" })).toEqual(settings({ privacyLevel: "SELF_ONLY" }));
  });

  it("has NO default privacy level", () => {
    expect(tiktokSettingsInputSchema.safeParse({}).success).toBe(false);
    expect(tiktokSettingsInputSchema.safeParse({ privacyLevel: "EVERYONE" }).success).toBe(false);
  });

  it("drops unknown keys instead of storing them", () => {
    expect(tiktokSettingsInputSchema.parse({ privacyLevel: "SELF_ONLY", title: "x" })).not.toHaveProperty("title");
  });

  it("bounds the per-channel map", () => {
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`c${i}`, settings()]));
    expect(tiktokInputSchema.safeParse({ byChannel: many }).success).toBe(false);
    expect(tiktokInputSchema.safeParse({ byChannel: { ["x".repeat(65)]: settings() } }).success).toBe(false);
  });
});

describe("buildTikTokByChannel", () => {
  it("keeps only TikTok channels this post targets", () => {
    const input = tiktokInputSchema.parse({ byChannel: { a: settings(), ig1: settings(), ghost: settings() } });
    expect(buildTikTokByChannel(input, [tt("a"), ig("ig1")])).toEqual({ a: settings() });
  });

  it("is undefined when nothing applies (keeps a non-TikTok post's metadata untouched)", () => {
    expect(buildTikTokByChannel(undefined, [tt("a")])).toBeUndefined();
    const input = tiktokInputSchema.parse({ byChannel: { ig1: settings() } });
    expect(buildTikTokByChannel(input, [ig("ig1")])).toBeUndefined();
  });

  it("never matches an inherited key", () => {
    const input = { byChannel: Object.create({ a: settings() }) } as any;
    expect(buildTikTokByChannel(input, [tt("a")])).toBeUndefined();
  });
});

describe("mergeTikTokByChannel", () => {
  it("overlays new choices on the stored ones and keeps other channels' settings", () => {
    const stored = { a: settings(), b: settings({ privacyLevel: "SELF_ONLY" }) };
    const input = tiktokInputSchema.parse({ byChannel: { a: settings({ privacyLevel: "FOLLOWER_OF_CREATOR" }) } });
    expect(mergeTikTokByChannel(stored, input, [tt("a"), tt("b")])).toEqual({
      a: settings({ privacyLevel: "FOLLOWER_OF_CREATOR" }),
      b: settings({ privacyLevel: "SELF_ONLY" }),
    });
  });

  it("drops settings for channels the post no longer targets", () => {
    expect(mergeTikTokByChannel({ a: settings(), gone: settings() }, undefined, [tt("a")])).toEqual({ a: settings() });
  });

  it("drops malformed stored entries rather than carrying them", () => {
    expect(mergeTikTokByChannel({ a: { privacyLevel: "NOPE" } }, undefined, [tt("a")])).toEqual({});
  });
});

describe("validateTikTokPost", () => {
  it("does nothing for a post with no TikTok channel", () => {
    expect(validateTikTokPost({ channels: [ig("i")], byChannel: undefined, media: [], scheduling: true })).toBeNull();
  });

  it("lets a DRAFT be saved without settings or media", () => {
    expect(validateTikTokPost({ channels: [tt("a")], byChannel: undefined, media: [], scheduling: false })).toBeNull();
  });

  it("names the TikTok channel whose visibility was never chosen", () => {
    const err = validateTikTokPost({
      channels: [tt("a", "Studio One"), tt("b", "Studio Two")],
      byChannel: { a: settings() },
      media: [video],
      scheduling: true,
    });
    expect(err).toBe("Choose who can see this post on Studio Two (TikTok).");
  });

  it("treats a malformed stored entry as not chosen", () => {
    const err = validateTikTokPost({ channels: [tt("a", "S")], byChannel: { a: { privacyLevel: "X" } }, media: [video], scheduling: true });
    expect(err).toBe("Choose who can see this post on S (TikTok).");
  });

  it("requires exactly one video", () => {
    const base = { channels: [tt("a")], byChannel: { a: settings() }, scheduling: true };
    expect(validateTikTokPost({ ...base, media: [] })).toBe(TIKTOK_EXACTLY_ONE_VIDEO_MESSAGE);
    expect(validateTikTokPost({ ...base, media: [video, video] })).toBe(TIKTOK_EXACTLY_ONE_VIDEO_MESSAGE);
    expect(validateTikTokPost({ ...base, media: [{ fileType: "image/png" }] })).toBe(TIKTOK_EXACTLY_ONE_VIDEO_MESSAGE);
    expect(validateTikTokPost({ ...base, media: [{ fileType: null }] })).toBe(TIKTOK_EXACTLY_ONE_VIDEO_MESSAGE);
    expect(TIKTOK_EXACTLY_ONE_VIDEO_MESSAGE).toBe("TikTok posts need exactly one video.");
    expect(validateTikTokPost({ ...base, media: [video] })).toBeNull();
  });

  it("refuses branded content that is private", () => {
    const err = validateTikTokPost({
      channels: [tt("a", "S")],
      byChannel: { a: settings({ privacyLevel: "SELF_ONLY", brandContent: true }) },
      media: [video],
      scheduling: true,
    });
    expect(err).toMatch(/Branded content can't be private on TikTok/);
    expect(err).toContain("S (TikTok)");
  });
});

describe("tiktokCannotPostReason", () => {
  it("has fixed text for every can't-post code and a fallback for the spam_risk family", () => {
    for (const code of ["spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "reached_active_user_cap", "spam_risk_too_many_pending_share", "spam_risk"]) {
      expect(tiktokCannotPostReason(code)).toMatch(/TikTok/);
    }
    expect(tiktokCannotPostReason("spam_risk_something_new")).toMatch(/TikTok/);
    expect(tiktokCannotPostReason("access_token_invalid")).toBeNull();
  });
});

describe("queryTikTokCreatorInfo", () => {
  afterEach(() => vi.unstubAllGlobals());

  const creatorData = {
    creator_avatar_url: "https://p16.tiktokcdn.com/a.jpg",
    creator_username: "studio.one",
    creator_nickname: "Studio One",
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: true,
    stitch_disabled: false,
    max_video_post_duration_sec: 600,
  };

  function stubFetch(status: number, body: unknown) {
    const fn = vi.fn(async (..._a: any[]) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("POSTs creator_info/query with the bearer token and reads success as error.code === 'ok'", async () => {
    const fn = stubFetch(200, { data: creatorData, error: { code: "ok", message: "", log_id: "202610281234401" } });
    const r = await queryTikTokCreatorInfo("tok-123");
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.creator.username).toBe("studio.one");
    const [url, init] = fn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://open.tiktokapis.com/v2/post/publish/creator_info/query/");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("maps a can't-post code to cannot_post", async () => {
    stubFetch(200, { data: {}, error: { code: "spam_risk_too_many_posts", message: "x", log_id: "1" } });
    const r = await queryTikTokCreatorInfo("tok");
    expect(r).toEqual({ kind: "cannot_post", code: "spam_risk_too_many_posts", creator: null });
  });

  it("maps a dead token or a missing scope to reconnect", async () => {
    stubFetch(401, { data: {}, error: { code: "access_token_invalid", message: "x", log_id: "401" } });
    expect((await queryTikTokCreatorInfo("tok")).kind).toBe("reconnect");
    stubFetch(401, { data: {}, error: { code: "scope_not_authorized", message: "x", log_id: "1" } });
    expect((await queryTikTokCreatorInfo("tok")).kind).toBe("reconnect");
  });

  it("anything else is unreachable — a 429, a 5xx, HTML, a network failure, no privacy options", async () => {
    stubFetch(429, { data: {}, error: { code: "rate_limit_exceeded", message: "x", log_id: "1" } });
    expect((await queryTikTokCreatorInfo("tok")).kind).toBe("unreachable");
    stubFetch(500, "<html>oops</html>");
    expect((await queryTikTokCreatorInfo("tok")).kind).toBe("unreachable");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect((await queryTikTokCreatorInfo("tok")).kind).toBe("unreachable");
    stubFetch(200, { data: { ...creatorData, privacy_level_options: [] }, error: { code: "ok" } });
    expect((await queryTikTokCreatorInfo("tok")).kind).toBe("unreachable");
  });
});
