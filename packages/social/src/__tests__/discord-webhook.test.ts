/**
 * Discord WEBHOOK publishing (token-connected channels, metadata.kind="webhook").
 *
 * It never ran before 2026-10-01: the publish worker passed no channel
 * metadata, so every webhook channel took the bot path and failed. Now that it
 * runs, it must follow the duplicate-post rules (CLAUDE.md "DUPLICATE POSTS
 * after Retry"): with plain fetch(), a connection dropped after Discord posted
 * the message was replayed by the worker's in-job loop (exactly "fetch failed")
 * and then by BullMQ — up to 9 copies. It now uses the same client and outcome
 * mapping as Mastodon and WordPress (review finding, 2026-10-01).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const userHostFetch = vi.fn(async (..._a: any[]): Promise<Response> => new Response("{}"));
vi.mock("../utils/user-host-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/user-host-fetch")>();
  return { ...actual, userHostFetch: (...a: any[]) => userHostFetch(...a) };
});
const globalFetch = vi.fn(async (..._a: any[]): Promise<Response> => new Response("{}"));
vi.stubGlobal("fetch", (...a: any[]) => globalFetch(...a));

import { DiscordProvider } from "../providers/discord.provider";
import { UserHostError } from "../utils/user-host-fetch";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";
import { isPublishRefusedError } from "../utils/publish-refused";

const HOOK = "https://discord.com/api/webhooks/123/abc";
const tokens = { accessToken: HOOK, metadata: { kind: "webhook", webhookUrl: HOOK, channelId: "c1", guildId: "g1" } } as any;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const p = new DiscordProvider();

beforeEach(() => {
  userHostFetch.mockReset();
  globalFetch.mockClear();
});

async function caught(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("DiscordProvider webhook publishPost", () => {
  it("posts through userHostFetch and links the message", async () => {
    userHostFetch.mockResolvedValueOnce(json(200, { id: "m9", channel_id: "c1" }));
    const r = await p.publishPost(tokens, { content: "hi", mediaUrls: ["https://postautomation.co.in/media/a.png"] } as any);
    expect(r).toMatchObject({ platformPostId: "c1:m9", url: "https://discord.com/channels/g1/c1/m9" });
    const [url, init] = userHostFetch.mock.calls[0]!;
    expect(url).toBe(`${HOOK}?wait=true`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ content: "hi", embeds: [{ image: { url: "https://postautomation.co.in/media/a.png" } }] });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("a connection lost after Discord received the post is UNCONFIRMED — never replayed", async () => {
    userHostFetch.mockRejectedValueOnce(new UserHostError("transport", { code: "ECONNRESET", requestSent: true }));
    const e = await caught(p.publishPost(tokens, { content: "hi" } as any));
    expect(isAmbiguousPublishError(e)).toBe(true);
    expect(e.message).not.toBe("fetch failed"); // the worker replays exactly that message in-job
  });

  it("a 5xx, or a 2xx without a message id, is unconfirmed", async () => {
    userHostFetch.mockResolvedValueOnce(json(502, {}));
    expect(isAmbiguousPublishError(await caught(p.publishPost(tokens, { content: "hi" } as any)))).toBe(true);
    userHostFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    expect(isAmbiguousPublishError(await caught(p.publishPost(tokens, { content: "hi" } as any)))).toBe(true);
  });

  it("a connection that never opened is retryable", async () => {
    userHostFetch.mockRejectedValueOnce(new UserHostError("transport", { code: "ECONNREFUSED", requestSent: false }));
    const e = await caught(p.publishPost(tokens, { content: "hi" } as any));
    expect(isAmbiguousPublishError(e)).toBe(false);
    expect(isPublishRefusedError(e)).toBe(false);
  });

  it("a deleted webhook is refused, not retried", async () => {
    userHostFetch.mockResolvedValueOnce(json(404, { message: "Unknown Webhook", code: 10015 }));
    const e = await caught(p.publishPost(tokens, { content: "hi" } as any));
    expect(isPublishRefusedError(e)).toBe(true);
    expect(e.message).toMatch(/Unknown Webhook/);
  });
});

describe("DiscordProvider bot path (OAuth) is unchanged", () => {
  it("still posts to the Discord API with plain fetch", async () => {
    globalFetch.mockResolvedValueOnce(json(200, { id: "m1", channel_id: "c1" }));
    await p.publishPost({ accessToken: "bot" } as any, { content: "hi", metadata: { channelId: "c1" } } as any);
    expect(globalFetch.mock.calls[0]![0]).toBe("https://discord.com/api/v10/channels/c1/messages");
    expect(userHostFetch).not.toHaveBeenCalled();
  });
});

describe("source lock", () => {
  it("never sends the webhook URL through plain fetch()", () => {
    const src = readFileSync(join(__dirname, "../providers/discord.provider.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/(?<!\w)fetch\(\s*`\$\{webhookUrl\}/);
  });
});
