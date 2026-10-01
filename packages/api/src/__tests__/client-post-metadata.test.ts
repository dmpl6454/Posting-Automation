import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripChannelRoutingKeys } from "../lib/client-post-metadata";

describe("stripChannelRoutingKeys", () => {
  it("drops every key that picks a destination or credential path, keeps the rest", () => {
    expect(
      stripChannelRoutingKeys({
        blog_id: "1",
        siteUrl: "http://10.0.0.1",
        instance: "https://evil.example",
        service: "https://pds.example",
        webhookUrl: "https://hooks.example",
        kind: "self-hosted",
        title: "My title",
        visibility: "public",
      }),
    ).toEqual({ title: "My title", visibility: "public" });
  });

  it("does not mutate its input", () => {
    const input = { blog_id: "1", title: "t" };
    stripChannelRoutingKeys(input);
    expect(input).toEqual({ blog_id: "1", title: "t" });
  });
});

describe("post.create wiring", () => {
  it("strips the routing keys from the client's metadata before storing it", () => {
    // Comments stripped: a commented-out call must not satisfy the lock.
    const src = readFileSync(join(__dirname, "../routers/post.router.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const block = src.slice(src.indexOf("instagramStory: _rawStory,"), src.indexOf("if (videoThumbnail) out.videoThumbnail"));
    expect(block).toMatch(/const out: Record<string, unknown> = stripChannelRoutingKeys\(rest\);/);
    // …and nothing in between puts the raw client keys back.
    expect(block.match(/\brest\b/g)?.length).toBe(2); // the destructure, and the one call above
  });
});
