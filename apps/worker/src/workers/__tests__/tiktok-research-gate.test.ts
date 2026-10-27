import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Social listening and brand-content sync call TikTok's RESEARCH API
 * (/v2/research/video/query/). That API needs a separately approved research
 * client; production holds the CONTENT POSTING app's keys, so every listening
 * sweep (every 30 min) and brand sync (every 4 h) spent a client-credentials
 * token mint plus a refused query, and swallowed the failure (TikTok audit,
 * 2026-10-28). Both fetchers are now behind TIKTOK_RESEARCH_ENABLED, which is
 * fail-CLOSED: only the exact string "true" turns them on. docker-compose's
 * explicit `environment:` allowlist delivers an unplumbed key as "", which must
 * read as OFF.
 */

vi.mock("@postautomation/queue", () => ({
  QUEUE_NAMES: { LISTENING_SYNC: "listening-sync", BRAND_CONTENT_SYNC: "brand-content-sync" },
  sentimentAnalysisQueue: {},
  SENTIMENT_BATCH_SIZE: 20,
  LISTENING_SYNC_INTERVAL_MS: 30 * 60 * 1000,
  createRedisConnection: () => ({}),
}));

import { isTikTokResearchEnabled } from "../../lib/tiktok-research";
import { __listeningFetchers, __resetListeningTokenCache } from "../listening-sync.worker";
import { __brandContentFetchers } from "../brand-content-sync.worker";

const KEYS = ["TIKTOK_RESEARCH_ENABLED", "TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"] as const;
let fetchMock: ReturnType<typeof vi.fn>;
const saved: Record<string, string | undefined> = {};

const listeningCtx = {
  keywords: ["acme"],
  language: "en",
  organizationId: "org1",
  queryId: "q1",
  interactive: false,
  channels: async () => [],
};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  // Credentials present — exactly the production situation that used to fire calls.
  process.env.TIKTOK_CLIENT_ID = "posting-app-key";
  process.env.TIKTOK_CLIENT_SECRET = "posting-app-secret";
  delete process.env.TIKTOK_RESEARCH_ENABLED;
  __resetListeningTokenCache();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized_client" }), { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isTikTokResearchEnabled — fail-closed", () => {
  it("is on only for the exact string \"true\"", () => {
    expect(isTikTokResearchEnabled({ TIKTOK_RESEARCH_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "1", "yes", "false", " true"]) {
      expect(isTikTokResearchEnabled({ TIKTOK_RESEARCH_ENABLED: v })).toBe(false);
    }
  });
});

describe.each([
  ["listening (keyword mentions)", () => __listeningFetchers.tiktok(listeningCtx as any)],
  ["brand-content sync (a tracked handle)", () => __brandContentFetchers.tiktok("@acme")],
])("TikTok %s", (_label, run) => {
  it.each([[undefined], [""], ["TRUE"], ["1"]])("makes NO request when TIKTOK_RESEARCH_ENABLED=%s", async (value) => {
    if (value === undefined) delete process.env.TIKTOK_RESEARCH_ENABLED;
    else process.env.TIKTOK_RESEARCH_ENABLED = value;
    expect(await run()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still calls TikTok when explicitly enabled", async () => {
    process.env.TIKTOK_RESEARCH_ENABLED = "true";
    expect(await run()).toEqual([]);
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://open.tiktokapis.com/v2/oauth/token/");
  });
});

describe("docker-compose.prod.yml plumbs the switch into the worker", () => {
  it("names TIKTOK_RESEARCH_ENABLED in the worker's environment allowlist", () => {
    const compose = readFileSync(join(__dirname, "../../../../../docker-compose.prod.yml"), "utf8");
    const start = compose.indexOf("\n  worker:\n");
    expect(start).toBeGreaterThan(-1);
    const rest = compose.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
    const worker = next === -1 ? rest : rest.slice(0, next + 1);
    expect(worker).toMatch(/\n\s+TIKTOK_RESEARCH_ENABLED: \$\{TIKTOK_RESEARCH_ENABLED\}\n/);
  });
});
