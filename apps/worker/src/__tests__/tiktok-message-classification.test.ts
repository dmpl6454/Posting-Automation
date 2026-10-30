/**
 * Every error the TikTok provider can throw, run through the worker's REAL
 * routing (2026-10-28, TikTok video posting).
 *
 * Why this matters: classifyError() substring-matches messages, and both its
 * token_expired and content_too_large branches call publishPost AGAIN, while
 * rate_limit re-queues the job. A TikTok error body used to be pasted into the
 * message, and its log_id is a digit run — one containing "401" turned a
 * SUCCESSFUL publish into "token expired" and a second copy of the video.
 *
 * The texts live in packages/social; the classifier lives here — only a test
 * that imports both keeps them compatible. The scenarios drive the real
 * provider against a fake TikTok whose every error body is hostile.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TikTokProvider,
  TIKTOK_MESSAGES,
  tiktokFailedMessage,
  tiktokInitRefusalMessage,
  tiktokCannotPostMessage,
} from "@postautomation/social";
import { classifyError, routePublishError, isDefiniteAuthFailure } from "../lib/publish-recovery";

const API = "https://open.tiktokapis.com/v2";
const MEDIA = "https://media.example.com/media/org/clip.mp4";
const UPLOAD = "https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=t";
const LOG_ID = "2026102840140399990TOKEN";
const HOSTILE = "token invalid expired 401 403 permission rate limit too many too large fetch failed ETIMEDOUT";
const SIZE = 12 * 1024 * 1024 + 7;

const SETTINGS = {
  privacyLevel: "SELF_ONLY",
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  brandOrganic: false,
  brandContent: false,
  isAigc: false,
};
const CREATOR = {
  creator_username: "creator.one",
  creator_nickname: "Creator One",
  privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  comment_disabled: false,
  duet_disabled: false,
  stitch_disabled: false,
  max_video_post_duration_sec: 600,
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json(200, { data, error: { code: "ok", message: "", log_id: LOG_ID } });
const fail = (status: number, code: string) => json(status, { data: {}, error: { code, message: HOSTILE, log_id: LOG_ID } });
const html = (status: number) => new Response(`<html>${HOSTILE} ${LOG_ID}</html>`, { status });
const transport = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
const status = (data: string) => new Response(`{"data":${data},"error":{"code":"ok","log_id":"${LOG_ID}"}}`, { status: 200 });

type H = () => Response | Promise<Response>;
interface Fake {
  creator?: H;
  init?: (n: number) => Response | Promise<Response>;
  status?: H;
  upload?: (isLast: boolean) => Response | Promise<Response>;
}

interface Run {
  name: string;
  err: Error | null;
  /** init calls that TikTok ACCEPTED (returned a publish_id). */
  okInits: number;
  checkpointed: boolean;
}

async function run(name: string, fake: Fake, opts: { checkpoint?: boolean } = {}): Promise<Run> {
  let inits = 0;
  let okInits = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith(MEDIA)) {
        if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(SIZE), "content-type": "video/mp4" } });
        const m = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get("range") ?? "");
        const len = m ? Number(m[2]) - Number(m[1]) + 1 : SIZE;
        return new Response(new Uint8Array(len), { status: m ? 206 : 200 });
      }
      if (url.startsWith(UPLOAD.split("?")[0]!)) {
        const cr = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get("content-range") ?? "";
        const isLast = cr.includes(`-${SIZE - 1}/`);
        return (fake.upload ?? ((l: boolean) => new Response(null, { status: l ? 201 : 206 })))(isLast);
      }
      if (url === `${API}/post/publish/creator_info/query/`) return (fake.creator ?? (() => ok(CREATOR)))();
      if (url === `${API}/post/publish/video/init/`) {
        inits++;
        const res = await (fake.init ?? (() => ok({ publish_id: "v_pub_url~v2-1.1" })))(inits);
        const text = await res.clone().text().catch(() => "");
        if (res.status === 200 && text.includes('"publish_id"')) okInits++;
        return res;
      }
      if (url === `${API}/post/publish/status/fetch/`) {
        return (fake.status ?? (() => status(`{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7234567890123456789]}`)))();
      }
      return json(404, {});
    })
  );
  let checkpointed = false;
  const metadata: Record<string, unknown> = { tiktok: SETTINGS, channelUsername: "creator.one" };
  if (opts.checkpoint) {
    metadata.tiktokPublish = { publishId: "v_pub_url~v2-1.0", createdAt: new Date().toISOString(), source: "PULL_FROM_URL" };
    checkpointed = true;
  }
  const provider = new TikTokProvider({ sleep: async () => {}, pollIntervalMs: 5_000, pollBudgetMs: 20_000 });
  let err: Error | null = null;
  try {
    await provider.publishPost(
      { accessToken: "act.secret" },
      {
        content: "caption",
        mediaUrls: [MEDIA],
        mediaTypes: ["video/mp4"],
        metadata,
        onCheckpoint: async (patch) => {
          if ((patch as { tiktokPublish?: unknown }).tiktokPublish) checkpointed = true;
          Object.assign(metadata, patch);
        },
      }
    );
  } catch (e) {
    err = e as Error;
  }
  vi.unstubAllGlobals();
  return { name, err, okInits, checkpointed };
}

const unverifiedThen = (h: (n: number) => Response | Promise<Response>) => (n: number) =>
  n === 1 ? fail(403, "url_ownership_unverified") : h(n);
const fileInitOk = () => ok({ publish_id: "v_pub_file~v2-1.2", upload_url: UPLOAD });

async function everyRun(): Promise<Run[]> {
  const runs: Run[] = [];
  const creatorCodes = ["spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "reached_active_user_cap", "access_token_invalid", "scope_not_authorized", "rate_limit_exceeded", "unaudited_client_can_only_post_to_private_accounts", "weird_code"];
  for (const c of creatorCodes) runs.push(await run(`creator ${c}`, { creator: () => fail(c === "rate_limit_exceeded" ? 429 : c.startsWith("spam") || c === "reached_active_user_cap" ? 200 : 401, c) }));
  runs.push(await run("creator 503", { creator: () => html(503) }));
  runs.push(await run("creator transport", { creator: () => Promise.reject(transport("ECONNRESET")) }));
  runs.push(await run("creator no options", { creator: () => ok({ ...CREATOR, privacy_level_options: [] }) }));
  runs.push(await run("creator disallows privacy", { creator: () => ok({ ...CREATOR, privacy_level_options: ["FOLLOWER_OF_CREATOR"] }) }));

  const initCodes: Array<[number, string]> = [[400, "invalid_param"], [403, "privacy_level_option_mismatch"], [403, "spam_risk_too_many_posts"], [403, "reached_active_user_cap"], [403, "unaudited_client_can_only_post_to_private_accounts"], [401, "access_token_invalid"], [401, "scope_not_authorized"], [429, "rate_limit_exceeded"], [403, "brand_new_code"]];
  for (const [s, c] of initCodes) runs.push(await run(`init ${c}`, { init: () => fail(s, c) }));
  for (const s of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) runs.push(await run(`init html ${s}`, { init: () => html(s) }));
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EPIPE"]) {
    runs.push(await run(`init transport ${code}`, { init: () => Promise.reject(transport(code)) }));
  }
  runs.push(await run("init timeout", { init: () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")) }));
  runs.push(await run("init ok without id", { init: () => ok({}) }));

  // FILE_UPLOAD fallback.
  for (const [s, c] of initCodes) runs.push(await run(`file init ${c}`, { init: unverifiedThen(() => fail(s, c)) }));
  for (const s of [500, 503]) runs.push(await run(`file init html ${s}`, { init: unverifiedThen(() => html(s)) }));
  runs.push(await run("file init lost", { init: unverifiedThen(() => Promise.reject(transport("ECONNRESET"))) }));
  for (const s of [400, 403, 404, 416, 429, 500, 503]) {
    runs.push(await run(`chunk ${s}`, { init: unverifiedThen(fileInitOk), upload: () => new Response(`${HOSTILE}`, { status: s }) }));
    runs.push(await run(`final chunk ${s}`, { init: unverifiedThen(fileInitOk), upload: (l) => (l ? new Response(`${HOSTILE}`, { status: s }) : new Response(null, { status: 206 })) }));
  }
  runs.push(await run("chunk transport", { init: unverifiedThen(fileInitOk), upload: () => Promise.reject(transport("ECONNRESET")) }));

  // Polling, after a fresh init and on resume.
  const statusCases: Array<[string, H]> = [
    ["processing forever", () => status(`{"status":"PROCESSING_DOWNLOAD"}`)],
    ["5xx forever", () => html(503)],
    ["429 forever", () => fail(429, "rate_limit_exceeded")],
    ["invalid_publish_id", () => fail(400, "invalid_publish_id")],
    ["access_token_invalid", () => fail(401, "access_token_invalid")],
    ["scope_not_authorized", () => fail(401, "scope_not_authorized")],
    ["unknown status", () => status(`{"status":"SOMETHING_NEW"}`)],
  ];
  for (const reason of ["file_format_check_failed", "duration_check_failed", "internal", "video_pull_failed", "auth_removed", "spam_risk_text", "publish_cancelled", HOSTILE]) {
    statusCases.push([`FAILED ${reason}`, () => status(`{"status":"FAILED","fail_reason":${JSON.stringify(reason)}}`)]);
  }
  for (const [n, h] of statusCases) {
    runs.push(await run(`poll ${n}`, { status: h }));
    runs.push(await run(`resume ${n}`, { status: h, init: () => fail(403, "spam_risk_too_many_posts") }, { checkpoint: true }));
  }
  return runs;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TikTok publish errors vs the worker's routing", () => {
  it("retryable messages land on the branch they are meant for — never a re-publishing one by accident", async () => {
    const runs = (await everyRun()).filter((r) => r.err);
    expect(runs.length).toBeGreaterThan(80);
    const retryable = runs.filter((r) => routePublishError(r.err) === "classify");
    expect(retryable.length).toBeGreaterThan(20);
    for (const r of retryable) {
      const msg = r.err!.message;
      const kind = classifyError(msg);
      if (msg === TIKTOK_MESSAGES.tokenExpired) {
        expect(kind, r.name).toBe("token_expired");
        // token_expired REFRESHES AND PUBLISHES AGAIN — only safe when TikTok
        // accepted no init, or when a checkpoint makes that second call a resume.
        expect(r.okInits === 0 || r.checkpointed, r.name).toBe(true);
      } else if (msg === TIKTOK_MESSAGES.rateLimited) {
        expect(kind, r.name).toBe("rate_limit");
        // rate_limit re-queues a NEW job: same rule.
        expect(r.okInits === 0 || r.checkpointed, r.name).toBe(true);
      } else {
        expect(kind, `${r.name}: ${msg}`).toBe("unknown");
      }
      // post-publish.worker.ts replays publishPost in-job on exactly these.
      expect(msg, r.name).not.toBe("fetch failed");
      expect(msg, r.name).not.toMatch(/ETIMEDOUT/);
    }
  }, 60_000);

  it("no TikTok body, log_id, token or host ever reaches a message", async () => {
    for (const r of (await everyRun()).filter((x) => x.err)) {
      const msg = r.err!.message;
      expect(msg, r.name).not.toContain(LOG_ID);
      expect(msg, r.name).not.toContain(HOSTILE);
      expect(msg, r.name).not.toContain("act.secret");
      expect(msg, r.name).not.toContain("<html>");
      expect(msg, r.name).not.toMatch(/tiktokapis\.com|media\.example\.com/);
    }
  }, 60_000);

  it("a lost PULL init reply is ambiguous; every route the worker knows is exercised", async () => {
    const runs = (await everyRun()).filter((r) => r.err);
    const byName = new Map(runs.map((r) => [r.name, r]));
    for (const n of ["init transport ECONNRESET", "init transport ETIMEDOUT", "init transport EPIPE", "init timeout", "init html 502", "init ok without id", "poll invalid_publish_id", "resume invalid_publish_id"]) {
      expect(routePublishError(byName.get(n)!.err), n).toBe("ambiguous");
    }
    for (const n of ["init transport ECONNREFUSED", "init transport ENOTFOUND", "file init lost", "file init html 503", "poll processing forever", "resume 5xx forever"]) {
      expect(routePublishError(byName.get(n)!.err), n).toBe("classify");
    }
    expect(new Set(runs.map((r) => routePublishError(r.err)))).toEqual(new Set(["classify", "terminal", "ambiguous"]));
  }, 60_000);

  it("the fixed texts classify as intended", () => {
    expect(classifyError(TIKTOK_MESSAGES.tokenExpired)).toBe("token_expired");
    expect(classifyError(TIKTOK_MESSAGES.rateLimited)).toBe("rate_limit");
    for (const k of ["unreachable", "noPostingOptions", "uploadUnconfirmed", "mediaUnreadable", "uploadIncomplete", "stillProcessing", "checkpointUnsaved"] as const) {
      expect(classifyError(TIKTOK_MESSAGES[k]), k).toBe("unknown");
    }
    for (const reason of ["internal", "video_pull_failed"]) expect(classifyError(tiktokFailedMessage(reason)), reason).toBe("unknown");
    // Refusals are terminal before classification, but must not read as auth either.
    for (const m of [tiktokInitRefusalMessage("privacy_level_option_mismatch"), tiktokCannotPostMessage("spam_risk_too_many_posts")]) {
      expect(isDefiniteAuthFailure(m)).toBe(false);
    }
  });

  it("a refresh refused with invalid_grant reads as a dead credential; a server error does not", async () => {
    const config = { clientId: "c", clientSecret: "s", callbackUrl: "https://x.example/cb", scopes: [] };
    vi.stubGlobal("fetch", vi.fn(async () => json(400, { error: "invalid_grant", error_description: HOSTILE, log_id: LOG_ID })));
    const dead = await new TikTokProvider().refreshAccessToken("r", config).catch((e: Error) => e);
    expect(isDefiniteAuthFailure((dead as Error).message)).toBe(true);
    expect(isDefiniteAuthFailure(`Token expired and refresh failed: ${(dead as Error).message}. Reconnect this channel in Settings.`)).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => html(503)));
    const blip = await new TikTokProvider().refreshAccessToken("r", config).catch((e: Error) => e);
    expect(isDefiniteAuthFailure((blip as Error).message)).toBe(false);
  });
});
