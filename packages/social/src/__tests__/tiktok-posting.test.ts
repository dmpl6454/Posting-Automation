import { describe, it, expect } from "vitest";
import {
  fitTikTokTitle,
  TIKTOK_TITLE_MAX,
  planTikTokChunks,
  tiktokContentRange,
  TIKTOK_MIN_CHUNK,
  TIKTOK_MAX_CHUNK,
  TIKTOK_MAX_FINAL_CHUNK,
  parseCreatorInfo,
  readTikTokSettings,
  validateTikTokSettings,
  tiktokInteractionFlags,
  tiktokConsentText,
  extractPublicPostIds,
  classifyTikTokStatus,
  tiktokPostUrl,
  readTikTokCheckpoint,
  readTikTokSettingsForChannel,
  type TikTokPostSettings,
  type TikTokCreatorInfo,
} from "../utils/tiktok-posting";

const MB = 1024 * 1024;

describe("fitTikTokTitle", () => {
  it("leaves a caption within the limit untouched", () => {
    expect(fitTikTokTitle("hello")).toBe("hello");
    const exact = "x".repeat(TIKTOK_TITLE_MAX);
    expect(fitTikTokTitle(exact)).toBe(exact);
  });
  it("cuts to 2,200 UTF-16 units and never splits an emoji", () => {
    const long = "x".repeat(TIKTOK_TITLE_MAX - 1) + "😀" + "tail";
    const out = fitTikTokTitle(long);
    expect(out.length).toBeLessThanOrEqual(TIKTOK_TITLE_MAX);
    expect(out).toBe("x".repeat(TIKTOK_TITLE_MAX - 1)); // the emoji would straddle the limit
  });
});

describe("planTikTokChunks", () => {
  it("a file under 5 MiB is one chunk of its own size", () => {
    const p = planTikTokChunks(3 * MB);
    expect(p).toMatchObject({ chunkSize: 3 * MB, totalChunkCount: 1 });
    expect(p.ranges).toEqual([{ start: 0, end: 3 * MB - 1 }]);
  });

  it("splits into chunk_size pieces with the remainder folded into the last chunk", () => {
    const size = 25 * MB + 123;
    const p = planTikTokChunks(size);
    expect(p.chunkSize).toBe(10 * MB);
    expect(p.totalChunkCount).toBe(2); // floor(25.0001 / 10)
    expect(p.ranges[0]).toEqual({ start: 0, end: 10 * MB - 1 });
    expect(p.ranges[1]).toEqual({ start: 10 * MB, end: size - 1 });
  });

  it("covers every byte exactly once, for sizes around the boundaries", () => {
    for (const size of [5 * MB, 5 * MB + 1, 10 * MB, 10 * MB - 1, 19 * MB + 7, 1024 * MB, 4_000_000_000]) {
      const p = planTikTokChunks(size);
      expect(p.ranges.length).toBe(p.totalChunkCount);
      expect(p.totalChunkCount).toBe(Math.floor(size / p.chunkSize) || 1);
      let next = 0;
      for (const r of p.ranges) {
        expect(r.start).toBe(next);
        next = r.end + 1;
      }
      expect(next).toBe(size);
      expect(p.chunkSize).toBeGreaterThanOrEqual(Math.min(size, TIKTOK_MIN_CHUNK));
      expect(p.chunkSize).toBeLessThanOrEqual(TIKTOK_MAX_CHUNK);
      const last = p.ranges[p.ranges.length - 1]!;
      expect(last.end - last.start + 1).toBeLessThanOrEqual(TIKTOK_MAX_FINAL_CHUNK);
      expect(p.totalChunkCount).toBeLessThanOrEqual(1000);
    }
  });

  it("refuses an empty, fractional or over-4GB size", () => {
    expect(() => planTikTokChunks(0)).toThrow();
    expect(() => planTikTokChunks(1.5)).toThrow();
    expect(() => planTikTokChunks(4_000_000_001)).toThrow(/4 GB/);
  });

  it("builds the Content-Range header", () => {
    expect(tiktokContentRange({ start: 0, end: 9 }, 100)).toBe("bytes 0-9/100");
  });
});

const CREATOR_RAW = {
  creator_avatar_url: "https://p16.tiktokcdn.com/a.jpeg",
  creator_username: "agency.demo",
  creator_nickname: "Agency Demo",
  privacy_level_options: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY", "SOMETHING_NEW"],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 600,
};

describe("parseCreatorInfo", () => {
  it("reads TikTok's fields and drops unknown privacy values", () => {
    expect(parseCreatorInfo(CREATOR_RAW)).toEqual({
      nickname: "Agency Demo",
      username: "agency.demo",
      avatarUrl: "https://p16.tiktokcdn.com/a.jpeg",
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
      commentDisabled: false,
      duetDisabled: true,
      stitchDisabled: false,
      maxVideoPostDurationSec: 600,
    });
  });
  it("is null when no usable privacy option exists, and tolerates junk", () => {
    expect(parseCreatorInfo({ ...CREATOR_RAW, privacy_level_options: [] })).toBeNull();
    expect(parseCreatorInfo(null)).toBeNull();
    expect(parseCreatorInfo({ ...CREATOR_RAW, creator_avatar_url: "javascript:x", max_video_post_duration_sec: "x" })).toMatchObject({
      avatarUrl: null,
      maxVideoPostDurationSec: null,
    });
  });
});

const creator = parseCreatorInfo(CREATOR_RAW) as TikTokCreatorInfo;
const settings = (over: Partial<TikTokPostSettings> = {}): TikTokPostSettings => ({
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: false,
  allowStitch: true,
  brandOrganic: false,
  brandContent: false,
  isAigc: false,
  ...over,
});

describe("readTikTokSettings", () => {
  it("reads a stored block and coerces booleans strictly", () => {
    expect(readTikTokSettings({ tiktok: { privacyLevel: "SELF_ONLY", allowComment: "yes", allowDuet: true } })).toEqual({
      privacyLevel: "SELF_ONLY",
      allowComment: false,
      allowDuet: true,
      allowStitch: false,
      brandOrganic: false,
      brandContent: false,
      isAigc: false,
    });
  });
  it("is null without a valid privacy level — never a guessed default", () => {
    expect(readTikTokSettings({})).toBeNull();
    expect(readTikTokSettings({ tiktok: {} })).toBeNull();
    expect(readTikTokSettings({ tiktok: { privacyLevel: "PUBLIC" } })).toBeNull();
    expect(readTikTokSettings(null)).toBeNull();
  });
});

describe("validateTikTokSettings", () => {
  it("accepts settings the creator allows", () => {
    expect(validateTikTokSettings(settings(), creator, { videoDurationSec: 30 })).toBeNull();
  });
  it("refuses a privacy level the creator does not offer, naming the allowed ones", () => {
    const msg = validateTikTokSettings(settings({ privacyLevel: "MUTUAL_FOLLOW_FRIENDS" }), creator);
    expect(msg).toMatch(/Friends/);
    expect(msg).toMatch(/Everyone, Followers, Only me/);
  });
  it("refuses private branded content", () => {
    expect(validateTikTokSettings(settings({ privacyLevel: "SELF_ONLY", brandContent: true }), creator)).toMatch(/Branded content can't be private/);
  });
  it("refuses allowing an interaction the creator switched off", () => {
    expect(validateTikTokSettings(settings({ allowDuet: true }), creator)).toMatch(/Duet/);
  });
  it("refuses a video longer than the creator may post", () => {
    expect(validateTikTokSettings(settings(), creator, { videoDurationSec: 601 })).toMatch(/up to 600s/);
  });
});

describe("flags and consent", () => {
  it("maps allow* to TikTok's disable_* flags", () => {
    expect(tiktokInteractionFlags(settings())).toEqual({ disable_comment: false, disable_duet: true, disable_stitch: false });
  });
  it("names the Branded Content Policy only for branded posts", () => {
    // Verbatim from TikTok's guidelines — the default line has no full stop there.
    expect(tiktokConsentText({ brandContent: false })).toBe("By posting, you agree to TikTok's Music Usage Confirmation");
    expect(tiktokConsentText({ brandContent: true })).toMatch(/Branded Content Policy/);
  });
});

describe("status/fetch", () => {
  it("keeps a 19-digit post id exact (JSON.parse would round it)", () => {
    const raw = '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7340912345678901234]},"error":{"code":"ok"}}';
    expect(JSON.parse(raw).data.publicaly_available_post_id[0].toString()).not.toBe("7340912345678901234");
    expect(extractPublicPostIds(raw)).toEqual(["7340912345678901234"]);
    expect(classifyTikTokStatus(raw)).toEqual({ state: "complete", postIds: ["7340912345678901234"] });
  });
  it("complete with no public id (a private post) yields no ids", () => {
    expect(classifyTikTokStatus('{"data":{"status":"PUBLISH_COMPLETE"}}')).toEqual({ state: "complete", postIds: [] });
  });
  it("classifies processing, inbox, failure and anything unexpected", () => {
    expect(classifyTikTokStatus('{"data":{"status":"PROCESSING_UPLOAD"}}')).toEqual({ state: "processing", status: "PROCESSING_UPLOAD" });
    expect(classifyTikTokStatus('{"data":{"status":"PROCESSING_DOWNLOAD"}}').state).toBe("processing");
    expect(classifyTikTokStatus('{"data":{"status":"SEND_TO_USER_INBOX"}}')).toEqual({ state: "inbox" });
    expect(classifyTikTokStatus('{"data":{"status":"FAILED","fail_reason":"file_format_check_failed"}}')).toEqual({
      state: "failed",
      failReason: "file_format_check_failed",
    });
    expect(classifyTikTokStatus('{"data":{"status":"NEW_THING"}}')).toEqual({ state: "unknown", status: "NEW_THING" });
    expect(classifyTikTokStatus("<html>502</html>")).toEqual({ state: "unknown", status: "unreadable" });
  });
});

describe("tiktokPostUrl", () => {
  it("builds the real video URL, or the profile when there is no public id", () => {
    expect(tiktokPostUrl("agency.demo", "7340912345678901234")).toBe("https://www.tiktok.com/@agency.demo/video/7340912345678901234");
    expect(tiktokPostUrl("agency.demo", null)).toBe("https://www.tiktok.com/@agency.demo");
    expect(tiktokPostUrl(null, "123")).toBeNull();
    expect(tiktokPostUrl("bad name/../x", "123")).toBeNull();
  });
});

describe("checkpoint + per-channel settings", () => {
  it("reads a valid checkpoint and rejects junk", () => {
    const ok = { tiktokPublish: { publishId: "v_pub_url~v2-1.7340912345", createdAt: "2026-10-28T10:00:00.000Z", source: "PULL_FROM_URL" } };
    expect(readTikTokCheckpoint(ok)).toEqual(ok.tiktokPublish);
    expect(readTikTokCheckpoint({ tiktokPublish: { ...ok.tiktokPublish, publishId: "bad id with spaces" } })).toBeNull();
    expect(readTikTokCheckpoint({ tiktokPublish: { ...ok.tiktokPublish, source: "OTHER" } })).toBeNull();
    expect(readTikTokCheckpoint({})).toBeNull();
  });
  it("reads one channel's settings and never a prototype key", () => {
    const md = { tiktokByChannel: { ch1: { privacyLevel: "FOLLOWER_OF_CREATOR", allowComment: true } } };
    expect(readTikTokSettingsForChannel(md, "ch1")?.privacyLevel).toBe("FOLLOWER_OF_CREATOR");
    expect(readTikTokSettingsForChannel(md, "ch2")).toBeNull();
    expect(readTikTokSettingsForChannel(md, "__proto__")).toBeNull();
    expect(readTikTokSettingsForChannel(null, "ch1")).toBeNull();
  });
});
