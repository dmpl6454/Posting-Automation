import { describe, it, expect } from "vitest";
import {
  decodeEntities,
  isPerVideoCommentError,
  isQuotaError,
  isRelevantComment,
  isYouTubeTurn,
  pickRedditThreads,
  quotaDay,
  readYouTubeListeningConfig,
  redditCommentsFromListing,
  reserveYouTubeUnits,
  youtubeCommentsFromThreads,
  youtubeQuery,
  youtubeStatsById,
  youtubeVideoMention,
  youtubeVideosFromSearch,
  type UnitCounter,
} from "./listening-comments";

const post = { id: "abc", title: "Acme launches a new phone", permalink: "/r/gadgets/comments/abc/acme/", subreddit: "gadgets", numComments: 40 };

describe("relevance", () => {
  it("keeps a comment that names a keyword, or that sits under a post whose title does", () => {
    expect(isRelevantComment("love my acme", "Unrelated title", ["acme"])).toBe(true);
    expect(isRelevantComment("nice", "Acme launches", ["acme"])).toBe(true);
    expect(isRelevantComment("nice", "Some other thing", ["acme"])).toBe(false);
  });
});

describe("Reddit", () => {
  it("opens the most-discussed posts that have comments", () => {
    const ps = [
      { ...post, id: "a", numComments: 3 },
      { ...post, id: "b", numComments: 0 },
      { ...post, id: "c", numComments: 90 },
      { ...post, id: "d", numComments: 10 },
    ];
    expect(pickRedditThreads(ps, 2).map((p) => p.id)).toEqual(["c", "d"]);
  });

  it("flattens top-level + one level of replies, skipping deleted, removed, mods and AutoModerator", () => {
    const t1 = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
      kind: "t1",
      data: { id, name: `t1_${id}`, body, author: `user_${id}`, ups: 4, created_utc: 1759600000, permalink: `/r/gadgets/comments/abc/acme/${id}/`, ...extra },
    });
    const body = [
      { kind: "Listing", data: { children: [] } },
      {
        kind: "Listing",
        data: {
          children: [
            t1("c1", "Battery life is great", {
              replies: { kind: "Listing", data: { children: [t1("r1", "agreed!", { replies: { kind: "Listing", data: { children: [t1("deep", "too deep")] } } })] } },
            }),
            t1("c2", "[deleted]"),
            t1("c3", "[removed]"),
            t1("c4", "rules reminder", { author: "AutoModerator" }),
            t1("c5", "pinned", { stickied: true }),
            t1("c6", "mod note", { distinguished: "moderator" }),
            { kind: "more", data: { children: ["x", "y"] } },
          ],
        },
      },
    ];
    const out = redditCommentsFromListing(body, post, ["acme"]);
    expect(out.map((m) => m.platformPostId)).toEqual(["t1_c1", "t1_r1"]);
    expect(out[0]).toMatchObject({
      source: "REDDIT",
      sourceUrl: "https://reddit.com/r/gadgets/comments/abc/acme/c1/",
      authorName: "r/gadgets",
      authorHandle: "u/user_c1",
      engagements: 4,
      reach: 0,
      metadata: { kind: "comment", parentTitle: "Acme launches a new phone", parentUrl: "https://reddit.com/r/gadgets/comments/abc/acme/" },
    });
    expect(out[0]!.mentionedAt.toISOString()).toBe(new Date(1759600000 * 1000).toISOString());
  });

  it("under an off-topic title only comments that name the keyword count; garbage input is empty", () => {
    const offTopic = { ...post, title: "What phone should I buy?" };
    const body = [null, { data: { children: [
      { kind: "t1", data: { id: "a", body: "get the Acme one", author: "x" } },
      { kind: "t1", data: { id: "b", body: "iphone", author: "y" } },
    ] } }];
    expect(redditCommentsFromListing(body, offTopic, ["acme"]).map((m) => m.content)).toEqual(["get the Acme one"]);
    expect(redditCommentsFromListing(null, post, ["acme"])).toEqual([]);
    expect(redditCommentsFromListing({ error: 404 }, post, ["acme"])).toEqual([]);
  });
});

describe("YouTube parsing", () => {
  const search = {
    items: [
      { id: { kind: "youtube#video", videoId: "v1" }, snippet: { title: "Acme &amp; Co review", description: "Honest &#39;review&#39;", channelTitle: "Tech", channelId: "UC1", publishedAt: "2026-10-04T10:00:00Z", thumbnails: { medium: { url: "https://i.ytimg.com/v1.jpg" } } } },
      { id: { kind: "youtube#channel", channelId: "UC9" }, snippet: { title: "a channel" } },
    ],
  };

  it("query uses | for OR and quotes phrases", () => {
    expect(youtubeQuery(["acme", "acme phone"])).toBe('acme|"acme phone"');
  });

  it("videos: ids, decoded titles, stats → reach and engagements", () => {
    const vids = youtubeVideosFromSearch(search);
    expect(vids.map((v) => v.id)).toEqual(["v1"]);
    const stats = youtubeStatsById({ items: [{ id: "v1", statistics: { viewCount: "1200", likeCount: "80", commentCount: "15" } }] });
    const m = youtubeVideoMention(vids[0]!, stats.get("v1"));
    expect(m).toMatchObject({
      source: "YOUTUBE",
      platformPostId: "video:v1",
      sourceUrl: "https://www.youtube.com/watch?v=v1",
      authorName: "Tech",
      content: "Acme & Co review\nHonest 'review'",
      reach: 1200,
      engagements: 95,
      metadata: { kind: "video", videoId: "v1" },
    });
  });

  it("comments: plain text, relevance against the video title, deep link with lc=", () => {
    const vid = youtubeVideosFromSearch(search)[0]!;
    const threads = {
      items: [
        { id: "t1", snippet: { totalReplyCount: 2, topLevelComment: { id: "C1", snippet: { textOriginal: "great vid", authorDisplayName: "@fan", authorProfileImageUrl: "https://yt3/x.jpg", likeCount: 5, publishedAt: "2026-10-04T12:00:00Z" } } } },
        { id: "t2", snippet: { topLevelComment: { id: "C2", snippet: { textOriginal: "" } } } },
      ],
    };
    const out = youtubeCommentsFromThreads(threads, vid, ["acme"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      platformPostId: "comment:C1",
      sourceUrl: "https://www.youtube.com/watch?v=v1&lc=C1",
      authorName: "@fan",
      authorAvatar: "https://yt3/x.jpg",
      engagements: 7,
      metadata: { kind: "comment", parentTitle: "Acme & Co review" },
    });
    // Off-topic video title: only comments naming the keyword.
    const off = { ...vid, title: "Phone review" };
    expect(youtubeCommentsFromThreads(threads, off, ["acme"])).toEqual([]);
  });

  it("error reasons", () => {
    const err = (reason: string) => ({ error: { errors: [{ reason }] } });
    expect(isQuotaError(err("quotaExceeded"))).toBe(true);
    expect(isQuotaError(err("commentsDisabled"))).toBe(false);
    expect(isPerVideoCommentError(err("commentsDisabled"))).toBe(true);
    expect(isPerVideoCommentError(null)).toBe(false);
    expect(decodeEntities("&lt;b&gt;")).toBe("<b>");
  });
});

describe("YouTube cadence and budget", () => {
  it("config defaults and clamps", () => {
    expect(readYouTubeListeningConfig({})).toMatchObject({ dailyUnits: 1500, everyRuns: 12 });
    expect(readYouTubeListeningConfig({ YOUTUBE_LISTENING_DAILY_UNITS: "0" }).dailyUnits).toBe(0);
    expect(readYouTubeListeningConfig({ YOUTUBE_LISTENING_EVERY_RUNS: "999" }).everyRuns).toBe(48);
  });

  it("each query gets exactly one slot per cycle; a person asking always runs", () => {
    const turns = Array.from({ length: 12 }, (_, b) => isYouTubeTurn("query-123", b, 12, false)).filter(Boolean);
    expect(turns).toHaveLength(1);
    expect(isYouTubeTurn("query-123", 5, 12, true)).toBe(true);
    expect(isYouTubeTurn("q", 3, 1, false)).toBe(true);
  });

  it("budgets by the Pacific day Google resets on", () => {
    expect(quotaDay(new Date("2026-10-05T06:00:00Z"))).toBe("2026-10-04");
    expect(quotaDay(new Date("2026-10-05T08:00:00Z"))).toBe("2026-10-05");
  });

  function memCounter(): UnitCounter & { totals: Map<string, number> } {
    const totals = new Map<string, number>();
    return {
      totals,
      async incrBy(day, units) {
        totals.set(day, (totals.get(day) ?? 0) + units);
        return totals.get(day)!;
      },
      async decrBy(day, units) {
        totals.set(day, (totals.get(day) ?? 0) - units);
      },
    };
  }

  it("reserves up to the cap, gives back an over-reservation, and fails closed", async () => {
    const c = memCounter();
    const now = new Date("2026-10-05T12:00:00Z");
    expect(await reserveYouTubeUnits(c, 100, 250, now)).toBe(true);
    expect(await reserveYouTubeUnits(c, 100, 250, now)).toBe(true);
    expect(await reserveYouTubeUnits(c, 100, 250, now)).toBe(false);
    expect(c.totals.get("2026-10-05")).toBe(200);
    expect(await reserveYouTubeUnits(c, 1, 250, now)).toBe(true);
    const broken: UnitCounter = { incrBy: async () => { throw new Error("redis down"); }, decrBy: async () => {} };
    expect(await reserveYouTubeUnits(broken, 1, 250, now)).toBe(false);
    expect(await reserveYouTubeUnits(c, 1, 0, now)).toBe(false);
  });
});
