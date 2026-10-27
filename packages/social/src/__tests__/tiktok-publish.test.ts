import { describe, it, expect, vi, afterEach } from "vitest";
import { TikTokProvider, TIKTOK_MESSAGES } from "../providers/tiktok.provider";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";
import { isPublishRefusedError } from "../utils/publish-refused";
import { planTikTokChunks, tiktokContentRange, type TikTokPostSettings } from "../utils/tiktok-posting";

/**
 * TikTok Direct Post publishing (2026-10-28).
 *
 * What these lock — each one a defect in the pre-2026-10-28 provider:
 *   1. success is `error.code === "ok"`; the old code threw on every SUCCESSFUL
 *      init, and the worker then posted the video again (up to six copies);
 *   2. no defaults: no settings ⇒ refused before anything is sent;
 *   3. fresh creator_info before every init, and the settings are checked
 *      against it;
 *   4. init is the irreversible step: a lost reply is AMBIGUOUS, and the
 *      publish_id is checkpointed before anything else so a retry RESUMES that
 *      publish instead of posting a second copy;
 *   5. the video is never downloaded whole (the old code buffered up to 4 GB);
 *   6. a 19-digit post id survives (JSON.parse would round it);
 *   7. no TikTok body ever reaches an error message — its log_id digits
 *      ("…401…") used to be read as an expired token and RE-PUBLISHED.
 */

const API = "https://open.tiktokapis.com/v2";
const MEDIA = "https://media.example.com/media/org-1/clip.mp4";
const UPLOAD_URL = "https://open-upload.tiktokapis.com/video/?upload_id=67890&upload_token=Xza123";
const LOG_ID = "20261028401403999TOKENINVALID";
const HOSTILE = "token invalid 401 403 permission rate limit too many too large fetch failed ETIMEDOUT";
const BIG_ID = "7234567890123456789"; // > Number.MAX_SAFE_INTEGER
const PUBLISH_ID = "v_pub_url~v2-1.7234567890123456789";

const SETTINGS: TikTokPostSettings = {
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: false,
  allowStitch: false,
  brandOrganic: true,
  brandContent: false,
  isAigc: true,
};

const CREATOR = {
  creator_avatar_url: "https://p16.tiktokcdn.com/creator.jpg",
  creator_username: "creator.one",
  creator_nickname: "Creator One",
  privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
  comment_disabled: false,
  duet_disabled: false,
  stitch_disabled: false,
  max_video_post_duration_sec: 600,
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  json?: any;
  bodyBytes?: number;
  hasSignal: boolean;
}

type Handler = (call: Call, n: number) => Response | Promise<Response>;

interface Server {
  creator?: Handler;
  init?: Handler;
  status?: Handler;
  upload?: Handler;
  mediaSize?: number;
  mediaType?: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (data: unknown) => json(200, { data, error: { code: "ok", message: "", log_id: LOG_ID } });
const fail = (status: number, code: string) =>
  json(status, { data: {}, error: { code, message: HOSTILE, log_id: LOG_ID } });
/** A status body written as RAW text, the way TikTok sends a list<int64>. */
const statusRaw = (data: string) =>
  new Response(`{"data":${data},"error":{"code":"ok","message":"","log_id":"${LOG_ID}"}}`, { status: 200 });
const processing = (extra = "") => statusRaw(`{"status":"PROCESSING_DOWNLOAD"${extra}}`);
const complete = (ids = `[${BIG_ID}]`) => statusRaw(`{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":${ids}}`);
const failed = (reason: string) => statusRaw(`{"status":"FAILED","fail_reason":"${reason}"}`);
const html = (status: number) => new Response(`<html><body>${HOSTILE}</body></html>`, { status, headers: { "content-type": "text/html" } });

const transport = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

function mockServer(s: Server) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => (headers[k] = v));
      const call: Call = { url, method, headers, hasSignal: !!init?.signal };
      if (typeof init?.body === "string") {
        try {
          call.json = JSON.parse(init.body);
        } catch {
          call.json = init.body;
        }
      } else if (init?.body instanceof Uint8Array) {
        call.bodyBytes = init.body.byteLength;
      }
      calls.push(call);
      const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

      if (url.startsWith(MEDIA)) {
        const size = s.mediaSize ?? 30 * 1024 * 1024;
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(size), "content-type": s.mediaType ?? "video/mp4" },
          });
        }
        const range = /bytes=(\d+)-(\d+)/.exec(headers.range ?? "");
        if (!range) return new Response(new Uint8Array(size), { status: 200 }); // a WHOLE download — asserted against
        const len = Number(range[2]) - Number(range[1]) + 1;
        return new Response(new Uint8Array(len), { status: 206, headers: { "content-range": `bytes ${range[1]}-${range[2]}/${size}` } });
      }
      if (url === `${API}/post/publish/creator_info/query/`) return (s.creator ?? (() => ok(CREATOR)))(call, bump("creator"));
      if (url === `${API}/post/publish/video/init/`) return (s.init ?? (() => ok({ publish_id: PUBLISH_ID })))(call, bump("init"));
      if (url === `${API}/post/publish/status/fetch/`) return (s.status ?? (() => complete()))(call, bump("status"));
      if (url.startsWith("https://open-upload.tiktokapis.com/")) {
        return (s.upload ?? ((c) => (c.headers["content-range"]?.endsWith(`/${s.mediaSize}`) && isLastRange(c, s.mediaSize!) ? new Response(null, { status: 201 }) : new Response(null, { status: 206 }))))(call, bump("upload"));
      }
      return json(404, { error: { code: "not_found" } });
    })
  );
  return { calls, counts };
}

function isLastRange(c: Call, size: number) {
  const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(c.headers["content-range"] ?? "");
  return !!m && Number(m[2]) === size - 1;
}

function payload(over: { metadata?: Record<string, unknown>; mediaUrls?: string[]; mediaTypes?: string[]; content?: string } = {}) {
  const metadata: Record<string, unknown> = { tiktok: SETTINGS, channelUsername: "creator.one", ...(over.metadata ?? {}) };
  const checkpoints: Record<string, unknown>[] = [];
  const progress: number[] = [];
  return {
    checkpoints,
    progress,
    metadata,
    payload: {
      content: over.content ?? "this will be a funny #cat video",
      mediaUrls: over.mediaUrls ?? [MEDIA],
      mediaTypes: over.mediaTypes ?? ["video/mp4"],
      metadata,
      onProgress: (p: number) => {
        progress.push(p);
      },
      onCheckpoint: async (patch: Record<string, unknown>) => {
        checkpoints.push(patch);
        Object.assign(metadata, patch);
      },
    },
  };
}

const provider = (o: { pollBudgetMs?: number } = {}) =>
  new TikTokProvider({ sleep: async () => {}, pollIntervalMs: 5_000, pollBudgetMs: o.pollBudgetMs ?? 8 * 60_000 });

const TOKENS = { accessToken: "act.secret-token-value" };

async function failWith(p: Promise<unknown>): Promise<Error> {
  const r = await p.then(
    () => null,
    (e) => e as Error
  );
  if (!r) throw new Error("expected the publish to fail");
  return r;
}

function expectClean(err: Error) {
  expect(err.message).not.toContain(LOG_ID);
  expect(err.message).not.toContain(HOSTILE);
  expect(err.message).not.toContain("act.secret");
  expect(err.message).not.toContain("<html>");
  expect(err.message).not.toContain("open.tiktokapis.com");
  expect(err.message).not.toContain("media.example.com");
}

const tiktokCalls = (calls: Call[], path: string) => calls.filter((c) => c.url === `${API}${path}`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TikTok publish — happy path (PULL_FROM_URL)", () => {
  it("creator_info → init → checkpoint → status; success is error.code ok; the 19-digit id survives", async () => {
    let statusN = 0;
    const { calls } = mockServer({ status: () => (++statusN < 3 ? processing(`,"downloaded_bytes":${statusN * 1000}`) : complete()) });
    const t = payload();

    const res = await provider().publishPost(TOKENS, t.payload);

    // creator_info strictly before init, init exactly once.
    const order = calls.filter((c) => c.url.startsWith(API)).map((c) => c.url.replace(API, ""));
    expect(order[0]).toBe("/post/publish/creator_info/query/");
    expect(order[1]).toBe("/post/publish/video/init/");
    expect(tiktokCalls(calls, "/post/publish/video/init/")).toHaveLength(1);

    const init = tiktokCalls(calls, "/post/publish/video/init/")[0]!;
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Bearer ${TOKENS.accessToken}`);
    expect(JSON.stringify(init.json)).toBe(
      JSON.stringify({
        post_info: {
          title: "this will be a funny #cat video",
          privacy_level: "PUBLIC_TO_EVERYONE",
          disable_comment: false,
          disable_duet: true,
          disable_stitch: true,
          brand_content_toggle: false,
          brand_organic_toggle: true,
          is_aigc: true,
        },
        source_info: { source: "PULL_FROM_URL", video_url: MEDIA },
      })
    );

    // Checkpoint written once, BEFORE the first status read.
    expect(t.checkpoints).toHaveLength(1);
    const cp = (t.checkpoints[0] as any).tiktokPublish;
    expect(cp.publishId).toBe(PUBLISH_ID);
    expect(cp.source).toBe("PULL_FROM_URL");
    expect(Number.isNaN(Date.parse(cp.createdAt))).toBe(false);

    const status = tiktokCalls(calls, "/post/publish/status/fetch/");
    expect(status).toHaveLength(3);
    expect(status[0]!.json).toEqual({ publish_id: PUBLISH_ID });

    expect(res).toEqual({
      platformPostId: BIG_ID,
      url: `https://www.tiktok.com/@creator.one/video/${BIG_ID}`,
      metadata: { publishId: PUBLISH_ID, postId: BIG_ID, privacyLevel: "PUBLIC_TO_EVERYONE", status: "PUBLISH_COMPLETE" },
    });

    // The video is never fetched by us on the PULL path.
    expect(calls.filter((c) => c.url.startsWith(MEDIA))).toHaveLength(0);
    // Every TikTok request is time-bounded.
    expect(calls.filter((c) => c.url.startsWith(API)).every((c) => c.hasSignal)).toBe(true);
    expect(t.progress.at(-1)).toBe(100);
    expect(t.progress.every((p) => Number.isFinite(p) && p >= 0 && p <= 100)).toBe(true);
  });

  it("a private post (no public id) adopts the publish_id and links the profile, never @me", async () => {
    mockServer({ status: () => complete("[]") });
    const t = payload({ metadata: { tiktok: { ...SETTINGS, privacyLevel: "SELF_ONLY" } } });
    const res = await provider().publishPost(TOKENS, t.payload);
    expect(res.platformPostId).toBe(PUBLISH_ID);
    expect(res.url).toBe("https://www.tiktok.com/@creator.one");
    expect(res.metadata).toMatchObject({ postId: null, privacyLevel: "SELF_ONLY" });
  });

  it("an empty caption sends no title", async () => {
    const { calls } = mockServer({});
    await provider().publishPost(TOKENS, payload({ content: "" }).payload);
    expect(tiktokCalls(calls, "/post/publish/video/init/")[0]!.json.post_info).not.toHaveProperty("title");
  });

  it("a long caption is cut to 2,200 UTF-16 units without splitting an emoji", async () => {
    const { calls } = mockServer({});
    await provider().publishPost(TOKENS, payload({ content: "x".repeat(2199) + "😀tail" }).payload);
    expect(tiktokCalls(calls, "/post/publish/video/init/")[0]!.json.post_info.title).toBe("x".repeat(2199));
  });

  it("SEND_TO_USER_INBOX is a success with a note", async () => {
    mockServer({ status: () => statusRaw(`{"status":"SEND_TO_USER_INBOX"}`) });
    const res = await provider().publishPost(TOKENS, payload().payload);
    expect(res.platformPostId).toBe(PUBLISH_ID);
    expect(res.metadata).toMatchObject({ status: "SEND_TO_USER_INBOX", note: expect.any(String) });
  });
});

describe("TikTok publish — refused before anything is sent", () => {
  it("no settings ⇒ PublishRefusedError(rejected), no request at all", async () => {
    const { calls } = mockServer({});
    const t = payload();
    delete t.metadata.tiktok;
    const err = await failWith(provider().publishPost(TOKENS, t.payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect((err as any).reason).toBe("rejected");
    expect(err.message).toBe(
      "Choose who can see this TikTok post (privacy) in Content Studio, then publish again. Nothing was sent to TikTok."
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no media", { mediaUrls: [], mediaTypes: [] }],
    ["two videos", { mediaUrls: [MEDIA, MEDIA], mediaTypes: ["video/mp4", "video/mp4"] }],
    ["an image", { mediaUrls: ["https://media.example.com/media/a.jpg"], mediaTypes: ["image/jpeg"] }],
  ])("%s ⇒ refused, no request", async (_n, over) => {
    const { calls } = mockServer({});
    const err = await failWith(provider().publishPost(TOKENS, payload(over).payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect(err.message).toBe(TIKTOK_MESSAGES.videoRequired);
    expect(calls).toHaveLength(0);
  });

  it("a video recognised by its extension alone is accepted", async () => {
    mockServer({});
    const res = await provider().publishPost(TOKENS, payload({ mediaTypes: [], mediaUrls: ["https://media.example.com/media/a.MOV?x=1"] }).payload);
    expect(res.platformPostId).toBe(BIG_ID);
  });

  it.each(["spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "reached_active_user_cap"])(
    "creator_info says %s (HTTP 200, intentional) ⇒ refused with the fixed can't-post message, no init",
    async (code) => {
      const { counts } = mockServer({ creator: () => fail(200, code) });
      const err = await failWith(provider().publishPost(TOKENS, payload().payload));
      expect(isPublishRefusedError(err)).toBe(true);
      expect(err.message).toContain("This TikTok account can't post right now (TikTok limit");
      expect(err.message).toContain("try again later");
      expectClean(err);
      expect(counts.init ?? 0).toBe(0);
    }
  );

  it("creator_info access_token_invalid ⇒ a plain token-expired error (safe: nothing created)", async () => {
    const { counts } = mockServer({ creator: () => fail(401, "access_token_invalid") });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.tokenExpired);
    expect(isPublishRefusedError(err)).toBe(false);
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(counts.init ?? 0).toBe(0);
  });

  it("creator_info scope_not_authorized ⇒ refused(credentials)", async () => {
    mockServer({ creator: () => fail(401, "scope_not_authorized") });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect((err as any).reason).toBe("credentials");
    expect(err.message).toMatch(/reconnect TikTok/i);
    expectClean(err);
  });

  it.each([
    ["an HTML 503", () => html(503)],
    ["a rate limit", () => fail(429, "rate_limit_exceeded")],
  ])("creator_info %s ⇒ retryable, no init", async (_n, h) => {
    const { counts } = mockServer({ creator: h });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isPublishRefusedError(err)).toBe(false);
    expect(isAmbiguousPublishError(err)).toBe(false);
    expectClean(err);
    expect(counts.init ?? 0).toBe(0);
  });

  it("creator_info transport failure ⇒ retryable, no init", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      throw transport("ECONNRESET");
    }));
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.unreachable);
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(n).toBe(1);
  });

  it("creator_info without privacy options ⇒ retryable", async () => {
    const { counts } = mockServer({ creator: () => ok({ ...CREATOR, privacy_level_options: [] }) });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.noPostingOptions);
    expect(isPublishRefusedError(err)).toBe(false);
    expect(counts.init ?? 0).toBe(0);
  });

  it("a privacy level the creator no longer allows ⇒ refused with validateTikTokSettings' message", async () => {
    const { counts } = mockServer({ creator: () => ok({ ...CREATOR, privacy_level_options: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"] }) });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect(err.message).toContain(`can't post with "Everyone" visibility`);
    expect(counts.init ?? 0).toBe(0);
  });

  it("allowing comments the creator switched off ⇒ refused", async () => {
    mockServer({ creator: () => ok({ ...CREATOR, comment_disabled: true }) });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect(err.message).toContain("comments");
  });

  it("a video longer than the creator may post ⇒ refused", async () => {
    mockServer({ creator: () => ok({ ...CREATOR, max_video_post_duration_sec: 60 }) });
    const err = await failWith(provider().publishPost(TOKENS, payload({ metadata: { videoDurationSec: 90.4 } }).payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect(err.message).toContain("up to 60s");
  });
});

describe("TikTok publish — init outcomes", () => {
  it.each([
    ["a reset after the request was sent", () => Promise.reject(transport("ECONNRESET"))],
    ["a timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ["a 5xx", () => html(502)],
    ["an unreadable 200", () => new Response("<html>ok?</html>", { status: 200 })],
    ["a 200 ok without a publish_id", () => ok({})],
    ["a 200 ok with a malformed publish_id", () => ok({ publish_id: "bad id with spaces" })],
  ])("%s ⇒ AmbiguousPublishError, never a re-init", async (_n, h) => {
    const { counts } = mockServer({ init: h as Handler });
    const t = payload();
    const err = await failWith(provider().publishPost(TOKENS, t.payload));
    expect(isAmbiguousPublishError(err)).toBe(true);
    expect(counts.init).toBe(1);
    expect(t.checkpoints).toHaveLength(0);
    expectClean(err);
  });

  it("a failure that provably never left (ECONNREFUSED) ⇒ plain retryable", async () => {
    mockServer({ init: () => Promise.reject(transport("ECONNREFUSED")) });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(isPublishRefusedError(err)).toBe(false);
    expect(err.message).toBe(TIKTOK_MESSAGES.unreachable);
  });

  it("rate_limit_exceeded ⇒ the rate-limit message", async () => {
    mockServer({ init: () => fail(429, "rate_limit_exceeded") });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.rateLimited);
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(isPublishRefusedError(err)).toBe(false);
  });

  it("access_token_invalid ⇒ the token-expired message", async () => {
    mockServer({ init: () => fail(401, "access_token_invalid") });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.tokenExpired);
  });

  it("scope_not_authorized ⇒ refused(credentials)", async () => {
    mockServer({ init: () => fail(401, "scope_not_authorized") });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect((err as any).reason).toBe("credentials");
    expectClean(err);
  });

  it.each([
    "privacy_level_option_mismatch",
    "invalid_param",
    "spam_risk_too_many_posts",
    "spam_risk",
    "reached_active_user_cap",
    "unaudited_client_can_only_post_to_private_accounts",
    "some_new_code",
  ])("403/400 %s ⇒ refused(rejected), naming the code, never the body", async (code) => {
    mockServer({ init: () => fail(code === "invalid_param" ? 400 : 403, code) });
    const t = payload();
    const err = await failWith(provider().publishPost(TOKENS, t.payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect((err as any).reason).toBe("rejected");
    expect(err.message).toContain(code);
    expectClean(err);
    expect(t.checkpoints).toHaveLength(0);
  });

  it("a code that is not a code is not echoed", async () => {
    mockServer({ init: () => fail(400, `<script>${HOSTILE}</script>`) });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect(err.message).not.toContain("<script>");
    expectClean(err);
  });
});

describe("TikTok publish — checkpoint", () => {
  it("a checkpoint that cannot be stored after a PULL init ⇒ AmbiguousPublishError (TikTok is already pulling)", async () => {
    const { counts } = mockServer({});
    const t = payload();
    t.payload.onCheckpoint = async () => {
      throw new Error("db down");
    };
    const err = await failWith(provider().publishPost(TOKENS, t.payload));
    expect(isAmbiguousPublishError(err)).toBe(true);
    expect(counts.status ?? 0).toBe(0);
    expect(err.message).toContain(PUBLISH_ID);
  });
});

describe("TikTok publish — resume from a checkpoint", () => {
  const checkpoint = (source = "PULL_FROM_URL") => ({
    tiktokPublish: { publishId: PUBLISH_ID, createdAt: new Date(Date.now() - 60_000).toISOString(), source },
  });

  it("PROCESSING then COMPLETE ⇒ adopts that publish; no creator_info, no init", async () => {
    let n = 0;
    const { counts } = mockServer({ status: () => (++n === 1 ? processing() : complete()) });
    const t = payload({ metadata: checkpoint() });
    const res = await provider().publishPost(TOKENS, t.payload);
    expect(counts.init ?? 0).toBe(0);
    expect(counts.creator ?? 0).toBe(0);
    expect(counts.status).toBe(2);
    expect(res.platformPostId).toBe(BIG_ID);
    expect(t.checkpoints).toHaveLength(0);
  });

  it("resumes even when the settings have since gone missing (the post may be live)", async () => {
    mockServer({});
    const t = payload({ metadata: checkpoint() });
    delete t.metadata.tiktok;
    const res = await provider().publishPost(TOKENS, t.payload);
    expect(res.platformPostId).toBe(BIG_ID);
  });

  it("FAILED ⇒ a NEW init is allowed (nothing is live)", async () => {
    let n = 0;
    const { counts } = mockServer({
      status: () => (++n === 1 ? failed("video_pull_failed") : complete()),
      init: () => ok({ publish_id: "v_pub_url~v2-1.second" }),
    });
    const t = payload({ metadata: checkpoint() });
    const res = await provider().publishPost(TOKENS, t.payload);
    expect(counts.creator).toBe(1);
    expect(counts.init).toBe(1);
    expect((t.checkpoints[0] as any).tiktokPublish.publishId).toBe("v_pub_url~v2-1.second");
    expect(res.metadata).toMatchObject({ publishId: "v_pub_url~v2-1.second" });
  });

  it.each(["invalid_publish_id", "token_not_authorized_for_specified_publish_id"])(
    "%s ⇒ AmbiguousPublishError (its fate cannot be learned), no init",
    async (code) => {
      const { counts } = mockServer({ status: () => fail(400, code) });
      const err = await failWith(provider().publishPost(TOKENS, payload({ metadata: checkpoint() }).payload));
      expect(isAmbiguousPublishError(err)).toBe(true);
      expect(counts.init ?? 0).toBe(0);
      expectClean(err);
    }
  );

  it("access_token_invalid on the status read ⇒ token-expired (the refreshed retry resumes, never re-inits)", async () => {
    const { counts } = mockServer({ status: () => fail(401, "access_token_invalid") });
    const err = await failWith(provider().publishPost(TOKENS, payload({ metadata: checkpoint() }).payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.tokenExpired);
    expect(counts.init ?? 0).toBe(0);
  });

  it("a FILE_UPLOAD checkpoint resumes the same way", async () => {
    const { counts } = mockServer({});
    const res = await provider().publishPost(TOKENS, payload({ metadata: checkpoint("FILE_UPLOAD") }).payload);
    expect(counts.init ?? 0).toBe(0);
    expect(res.platformPostId).toBe(BIG_ID);
  });
});

describe("TikTok publish — polling", () => {
  it("still processing at the end of the budget ⇒ plain retryable (the checkpoint makes the retry resume)", async () => {
    const { counts } = mockServer({ status: () => processing() });
    const t = payload();
    const err = await failWith(provider().publishPost(TOKENS, t.payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.stillProcessing);
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(isPublishRefusedError(err)).toBe(false);
    // 8 minutes at 5 s = 96 reads, not one more.
    expect(counts.status).toBe(96);
    expect(t.checkpoints).toHaveLength(1);
  });

  it("a short budget polls proportionally fewer times", async () => {
    const { counts } = mockServer({ status: () => processing() });
    await failWith(provider({ pollBudgetMs: 30_000 }).publishPost(TOKENS, payload().payload));
    expect(counts.status).toBe(6);
  });

  it.each([
    ["5xx", () => html(503)],
    ["rate limit", () => fail(429, "rate_limit_exceeded")],
    ["transport", () => Promise.reject(transport("ECONNRESET"))],
    ["unreadable 200", () => new Response("not json", { status: 200 })],
  ])("a %s mid-poll keeps polling", async (_n, bad) => {
    let n = 0;
    mockServer({ status: () => (++n < 4 ? (bad as () => Response)() : complete()) });
    const res = await provider().publishPost(TOKENS, payload().payload);
    expect(res.platformPostId).toBe(BIG_ID);
  });

  it("status reads failing for the whole budget ⇒ the same retryable message, NOT ambiguous", async () => {
    mockServer({ status: () => html(502) });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.stillProcessing);
    expect(isAmbiguousPublishError(err)).toBe(false);
  });

  it("FAILED ⇒ refused(rejected) naming the fail_reason", async () => {
    mockServer({ status: () => failed("file_format_check_failed") });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect((err as any).reason).toBe("rejected");
    expect(err.message).toContain("file_format_check_failed");
  });

  it("FAILED with a reason TikTok calls retryable ⇒ plain retryable (the resume will re-init)", async () => {
    mockServer({ status: () => failed("internal") });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isPublishRefusedError(err)).toBe(false);
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(err.message).toContain("internal");
  });

  it("a FAILED reason that is not a code is not echoed", async () => {
    mockServer({ status: () => failed(`${HOSTILE}`) });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expectClean(err);
  });
});

describe("TikTok publish — FILE_UPLOAD fallback (url_ownership_unverified)", () => {
  const SIZE = 25 * 1024 * 1024 + 123;

  it("falls back to a streamed FILE_UPLOAD with TikTok's chunk headers; never downloads the whole file", async () => {
    let initN = 0;
    const { calls } = mockServer({
      mediaSize: SIZE,
      mediaType: "video/quicktime",
      init: (c) =>
        ++initN === 1
          ? fail(403, "url_ownership_unverified")
          : ok({ publish_id: "v_pub_file~v2-1.42", upload_url: UPLOAD_URL }),
    });
    const t = payload({ mediaTypes: ["video/quicktime"] });
    const res = await provider().publishPost(TOKENS, t.payload);

    const plan = planTikTokChunks(SIZE);
    const inits = tiktokCalls(calls, "/post/publish/video/init/");
    expect(inits).toHaveLength(2);
    expect(inits[1]!.json.source_info).toEqual({
      source: "FILE_UPLOAD",
      video_size: SIZE,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.totalChunkCount,
    });
    expect(inits[1]!.json.post_info).toEqual(inits[0]!.json.post_info);

    // Checkpointed BEFORE the first chunk.
    const firstPut = calls.findIndex((c) => c.method === "PUT");
    expect(t.checkpoints).toHaveLength(1);
    expect((t.checkpoints[0] as any).tiktokPublish).toMatchObject({ publishId: "v_pub_file~v2-1.42", source: "FILE_UPLOAD" });

    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(plan.totalChunkCount);
    puts.forEach((p, i) => {
      const r = plan.ranges[i]!;
      expect(p.url).toBe(UPLOAD_URL);
      expect(p.headers["content-range"]).toBe(tiktokContentRange(r, SIZE));
      expect(p.headers["content-type"]).toBe("video/quicktime");
      expect(p.headers["content-length"]).toBe(String(r.end - r.start + 1));
      expect(p.bodyBytes).toBe(r.end - r.start + 1);
      expect(p.hasSignal).toBe(true);
      // The chunk was read with a Range request just before its PUT.
      const idx = calls.indexOf(p);
      expect(calls[idx - 1]!.headers.range).toBe(`bytes=${r.start}-${r.end}`);
    });
    expect(firstPut).toBeGreaterThan(-1);

    // Never a whole-file GET of the video.
    const mediaGets = calls.filter((c) => c.url.startsWith(MEDIA) && c.method === "GET");
    expect(mediaGets.every((c) => !!c.headers.range)).toBe(true);
    expect(mediaGets).toHaveLength(plan.totalChunkCount);

    expect(res.platformPostId).toBe(BIG_ID);
    // Progress rose through the upload and finished at 100.
    expect(t.progress.at(-1)).toBe(100);
    for (let i = 1; i < t.progress.length; i++) expect(t.progress[i]!).toBeGreaterThanOrEqual(t.progress[i - 1]!);
  });

  it("a transient chunk failure is retried (same range) and the upload completes", async () => {
    let initN = 0;
    let putN = 0;
    const { calls } = mockServer({
      mediaSize: SIZE,
      init: () => (++initN === 1 ? fail(403, "url_ownership_unverified") : ok({ publish_id: "v_pub_file~v2-1.42", upload_url: UPLOAD_URL })),
      upload: (c) => {
        putN++;
        if (putN === 1) return html(503);
        return isLastRange(c, SIZE) ? new Response(null, { status: 201 }) : new Response(null, { status: 206 });
      },
    });
    const res = await provider().publishPost(TOKENS, payload().payload);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts[0]!.headers["content-range"]).toBe(puts[1]!.headers["content-range"]);
    expect(res.platformPostId).toBe(BIG_ID);
  });

  it("a NON-final chunk that keeps failing ⇒ retryable after 3 tries, and the checkpoint is cleared (TikTok can't post without the last chunk)", async () => {
    let initN = 0;
    let putN = 0;
    const { counts } = mockServer({
      mediaSize: SIZE,
      init: () => (++initN === 1 ? fail(403, "url_ownership_unverified") : ok({ publish_id: "v_pub_file~v2-1.42", upload_url: UPLOAD_URL })),
      upload: () => {
        putN++;
        return html(503);
      },
    });
    const t = payload();
    const err = await failWith(provider().publishPost(TOKENS, t.payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.uploadIncomplete);
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(isPublishRefusedError(err)).toBe(false);
    expect(putN).toBe(3);
    expect(counts.status ?? 0).toBe(0);
    expect(t.checkpoints.at(-1)).toEqual({ tiktokPublish: null });
  });

  it("the FINAL chunk failing ambiguously keeps the checkpoint (TikTok may have it all)", async () => {
    let initN = 0;
    const { calls } = mockServer({
      mediaSize: SIZE,
      init: () => (++initN === 1 ? fail(403, "url_ownership_unverified") : ok({ publish_id: "v_pub_file~v2-1.42", upload_url: UPLOAD_URL })),
      upload: (c) => (isLastRange(c, SIZE) ? Promise.reject(transport("ECONNRESET")) : new Response(null, { status: 206 })),
    });
    const t = payload();
    const err = await failWith(provider().publishPost(TOKENS, t.payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.uploadIncomplete);
    expect(t.checkpoints).toHaveLength(1);
    expect((t.checkpoints[0] as any).tiktokPublish.publishId).toBe("v_pub_file~v2-1.42");
    expect(calls.filter((c) => c.method === "PUT" && isLastRange(c, SIZE))).toHaveLength(3);
  });

  it("an expired upload_url (403) is not retried; the checkpoint is cleared", async () => {
    let initN = 0;
    let putN = 0;
    mockServer({
      mediaSize: SIZE,
      init: () => (++initN === 1 ? fail(403, "url_ownership_unverified") : ok({ publish_id: "v_pub_file~v2-1.42", upload_url: UPLOAD_URL })),
      upload: () => {
        putN++;
        return new Response(null, { status: 403 });
      },
    });
    const t = payload();
    const err = await failWith(provider().publishPost(TOKENS, t.payload));
    expect(err.message).toBe(TIKTOK_MESSAGES.uploadIncomplete);
    expect(putN).toBe(1);
    expect(t.checkpoints.at(-1)).toEqual({ tiktokPublish: null });
  });

  it("a lost FILE_UPLOAD init reply is retryable, not ambiguous (nothing can post without our chunks)", async () => {
    let initN = 0;
    mockServer({
      mediaSize: SIZE,
      init: () => (++initN === 1 ? fail(403, "url_ownership_unverified") : Promise.reject(transport("ECONNRESET"))),
    });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(isPublishRefusedError(err)).toBe(false);
  });

  it("a FILE_UPLOAD checkpoint that cannot be stored aborts before any chunk (retryable, not ambiguous)", async () => {
    let initN = 0;
    const { calls } = mockServer({
      mediaSize: SIZE,
      init: () => (++initN === 1 ? fail(403, "url_ownership_unverified") : ok({ publish_id: "v_pub_file~v2-1.42", upload_url: UPLOAD_URL })),
    });
    const t = payload();
    t.payload.onCheckpoint = async () => {
      throw new Error("db down");
    };
    const err = await failWith(provider().publishPost(TOKENS, t.payload));
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("a video over 4 GB is refused before the FILE_UPLOAD init", async () => {
    let initN = 0;
    const { counts } = mockServer({
      mediaSize: 4 * 1024 * 1024 * 1024 + 1,
      init: () => (++initN === 1 ? fail(403, "url_ownership_unverified") : ok({ publish_id: "x", upload_url: UPLOAD_URL })),
    });
    const err = await failWith(provider().publishPost(TOKENS, payload().payload));
    expect(isPublishRefusedError(err)).toBe(true);
    expect(counts.init).toBe(1);
  });
});

describe("TikTok — the rest of the provider contract", () => {
  it("findExistingPost returns null (resume lives in publishPost, from the checkpoint)", async () => {
    const p = provider();
    expect(await p.findExistingPost!(TOKENS, payload().payload, new Date())).toBeNull();
  });

  it("deletePost throws (TikTok has no delete API)", async () => {
    await expect(provider().deletePost(TOKENS, "1")).rejects.toThrow();
  });

  it("constraints match TikTok's limits", () => {
    const c = new TikTokProvider().constraints;
    expect(c).toEqual({
      maxContentLength: 2200,
      supportedMediaTypes: ["video/mp4", "video/quicktime", "video/webm"],
      maxMediaCount: 1,
      maxMediaSize: 4 * 1024 * 1024 * 1024,
    });
  });
});
