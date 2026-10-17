import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import {
  COMMENT_PERMISSION_DENIED_MESSAGE,
  COMMENT_TOKEN_INVALID_MESSAGE,
  COMMENT_MEDIA_GONE_MESSAGE,
  COMMENT_ACTION_FAILED_MESSAGE,
} from "../utils/instagram-comments";
import {
  COMMENT_CREATE_UNCONFIRMED_MESSAGE,
  COMMENT_CREATE_FAILED_MESSAGE,
  MENTION_REPLY_UNCONFIRMED_MESSAGE,
  MENTION_GONE_MESSAGE,
  IG_MENTIONED_COMMENT_FIELDS,
  IG_MENTIONED_MEDIA_FIELDS_MINIMAL,
  parseMentionWebhook,
  mentionDedupKey,
  readInstagramFirstComment,
  readFirstCommentRecord,
  safeInstagramPermalink,
} from "../utils/instagram-mentions";

interface Call {
  url: string;
  method: string;
  body?: any;
}

function mockGraph(handler: (url: string, method: string) => { ok: boolean; status?: number; body: any; throws?: boolean }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : undefined });
      const r = handler(String(url), method);
      if (r.throws) throw new Error("socket hang up");
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.body, headers: { get: () => null } } as any;
    })
  );
  return calls;
}

const tokens = { accessToken: "TOKEN" };
const provider = () => new InstagramProvider();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseMentionWebhook", () => {
  it("reads caption and comment mentions, dropping malformed ids and other fields", () => {
    const events = parseMentionWebhook({
      object: "instagram",
      entry: [
        {
          id: "17841405726653026",
          time: 1520622968,
          changes: [
            { field: "mentions", value: { media_id: "17918195224117851" } },
            { field: "mentions", value: { media_id: "17918195224117852", comment_id: "17900000000000001" } },
            { field: "mentions", value: { media_id: "../evil", comment_id: "1" } },
            { field: "mentions", value: { media_id: "123", comment_id: "x?y" } },
            { field: "story_insights", value: { media_id: "999" } },
          ],
        },
        { id: "not-an-id", changes: [{ field: "mentions", value: { media_id: "5" } }] },
      ],
    });
    expect(events).toEqual([
      { igUserId: "17841405726653026", mediaId: "17918195224117851", commentId: null, sentAt: new Date(1520622968000) },
      { igUserId: "17841405726653026", mediaId: "17918195224117852", commentId: "17900000000000001", sentAt: new Date(1520622968000) },
      { igUserId: "17841405726653026", mediaId: "123", commentId: null, sentAt: new Date(1520622968000) },
    ]);
  });

  it("ignores non-instagram payloads and garbage", () => {
    expect(parseMentionWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(parseMentionWebhook(null)).toEqual([]);
    expect(parseMentionWebhook({ object: "instagram", entry: "x" })).toEqual([]);
  });

  it("dedup key separates caption mentions from comment mentions on one media", () => {
    expect(mentionDedupKey("1", null)).toBe("1:caption");
    expect(mentionDedupKey("1", "2")).toBe("1:2");
  });
});

describe("pure readers", () => {
  it("permalink must be an https instagram.com link", () => {
    expect(safeInstagramPermalink("https://www.instagram.com/p/abc/")).toBe("https://www.instagram.com/p/abc/");
    expect(safeInstagramPermalink("javascript:alert(1)")).toBeNull();
    expect(safeInstagramPermalink("https://instagram.com.evil.tld/p/x")).toBeNull();
    expect(safeInstagramPermalink("http://www.instagram.com/p/abc/")).toBeNull();
  });

  it("first comment: trimmed text, empty or oversized reads as none", () => {
    expect(readInstagramFirstComment({ instagramFirstComment: { text: "  #tags  " } })).toEqual({ text: "#tags" });
    expect(readInstagramFirstComment({ instagramFirstComment: { text: "   " } })).toBeNull();
    expect(readInstagramFirstComment({ instagramFirstComment: { text: "x".repeat(2201) } })).toBeNull();
    expect(readInstagramFirstComment(null)).toBeNull();
  });

  it("first-comment record rejects unknown statuses", () => {
    expect(readFirstCommentRecord({ firstComment: { status: "posted", commentId: "9", at: "t" } })).toEqual({
      status: "posted",
      commentId: "9",
      error: undefined,
      at: "t",
    });
    expect(readFirstCommentRecord({ firstComment: { status: "weird" } })).toBeNull();
  });
});

describe("commentOnMedia", () => {
  it("POSTs to the media's /comments edge with the message in the body", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { id: "c1" } }));
    await expect(provider().commentOnMedia(tokens, "17890000000000001", "first!")).resolves.toEqual({ id: "c1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toMatch(/\/17890000000000001\/comments$/);
    expect(calls[0]!.body).toEqual({ message: "first!", access_token: "TOKEN" });
  });

  it("refuses a non-Graph media id before any request", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { id: "c1" } }));
    await expect(provider().commentOnMedia(tokens, "1/likes", "x")).rejects.toThrow(COMMENT_ACTION_FAILED_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["network drop", { ok: false, body: null, throws: true }],
    ["5xx", { ok: false, status: 500, body: { error: { code: 1 } } }],
    ["transient 4xx", { ok: false, status: 400, body: { error: { code: 2, is_transient: true } } }],
    ["OK without id", { ok: true, body: {} }],
  ])("an unknown outcome (%s) says it may already be posted", async (_l, r) => {
    mockGraph(() => r as any);
    await expect(provider().commentOnMedia(tokens, "1", "x")).rejects.toThrow(COMMENT_CREATE_UNCONFIRMED_MESSAGE);
    expect(COMMENT_CREATE_UNCONFIRMED_MESSAGE).toMatch(/may already be posted/);
  });

  it.each([
    [{ error: { code: 190 } }, COMMENT_TOKEN_INVALID_MESSAGE],
    [{ error: { code: 10, message: "(#10) Application does not have permission for this action" } }, COMMENT_PERMISSION_DENIED_MESSAGE],
    [{ error: { code: 100, error_subcode: 33 } }, COMMENT_MEDIA_GONE_MESSAGE],
    [{ error: { code: 100, message: "Invalid parameter" } }, COMMENT_CREATE_FAILED_MESSAGE],
  ])("classifies a definite refusal", async (body, msg) => {
    mockGraph(() => ({ ok: false, status: 400, body }));
    await expect(provider().commentOnMedia(tokens, "1", "x")).rejects.toThrow(msg);
  });
});

describe("replyToMention", () => {
  it("caption mention: media_id only", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { id: "r1" } }));
    await provider().replyToMention(tokens, "17841405726653026", "17918195224117851", null, "thanks!");
    expect(calls[0]!.url).toMatch(/\/17841405726653026\/mentions$/);
    expect(calls[0]!.body).toEqual({ media_id: "17918195224117851", message: "thanks!", access_token: "TOKEN" });
  });

  it("comment mention: adds comment_id", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { id: "r1" } }));
    await provider().replyToMention(tokens, "1", "2", "3", "hi");
    expect(calls[0]!.body).toEqual({ media_id: "2", comment_id: "3", message: "hi", access_token: "TOKEN" });
  });

  it("unknown outcome and gone object are classified", async () => {
    mockGraph(() => ({ ok: false, status: 503, body: null }));
    await expect(provider().replyToMention(tokens, "1", "2", null, "x")).rejects.toThrow(MENTION_REPLY_UNCONFIRMED_MESSAGE);
    mockGraph(() => ({ ok: false, status: 400, body: { error: { code: 100, error_subcode: 33 } } }));
    await expect(provider().replyToMention(tokens, "1", "2", null, "x")).rejects.toThrow(MENTION_GONE_MESSAGE);
  });
});

describe("getMentionDetails", () => {
  it("comment mention reads mentioned_comment with the media expansion", async () => {
    const calls = mockGraph(() => ({
      ok: true,
      body: {
        mentioned_comment: {
          id: "3",
          text: "love @us",
          timestamp: "2026-10-17T10:00:00+0000",
          media: { id: "2", permalink: "https://www.instagram.com/p/abc/", username: "fan", media_type: "IMAGE" },
        },
      },
    }));
    const d = await provider().getMentionDetails(tokens, "1", "2", "3");
    expect(decodeURIComponent(calls[0]!.url)).toContain(`mentioned_comment.comment_id(3){${IG_MENTIONED_COMMENT_FIELDS}}`);
    expect(d).toEqual({
      text: "love @us",
      username: "fan",
      permalink: "https://www.instagram.com/p/abc/",
      mediaType: "IMAGE",
      timestamp: "2026-10-17T10:00:00+0000",
    });
  });

  it("descends once to the minimal field set on a field-name error", async () => {
    let n = 0;
    const calls = mockGraph(() =>
      n++ === 0
        ? { ok: false, status: 400, body: { error: { code: 100, message: "(#100) Tried accessing nonexisting field (permalink)" } } }
        : { ok: true, body: { mentioned_media: { id: "2", caption: "hi @us" } } }
    );
    const d = await provider().getMentionDetails(tokens, "1", "2", null);
    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls[1]!.url)).toContain(`mentioned_media.media_id(2){${IG_MENTIONED_MEDIA_FIELDS_MINIMAL}}`);
    expect(d.text).toBe("hi @us");
  });

  it("refuses ids that are not Graph ids (they sit inside a field expansion)", async () => {
    const calls = mockGraph(() => ({ ok: true, body: {} }));
    await expect(provider().getMentionDetails(tokens, "1", "2){id}", null)).rejects.toThrow(COMMENT_ACTION_FAILED_MESSAGE);
    expect(calls).toHaveLength(0);
  });
});
