import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutTikTokChannels } from "./unattended-tiktok";

describe("withoutTikTokChannels — unattended producers never create TikTok targets", () => {
  it("drops TikTok channel ids and keeps the order of the rest", () => {
    const channels = [
      { id: "a", platform: "INSTAGRAM" },
      { id: "t", platform: "TIKTOK" },
      { id: "b", platform: "FACEBOOK" },
    ];
    expect(withoutTikTokChannels(["t", "b", "a"], channels)).toEqual({ ids: ["b", "a"], droppedTikTok: 1 });
  });

  it("keeps an id it knows nothing about (the post creation decides, as before)", () => {
    expect(withoutTikTokChannels(["x"], [])).toEqual({ ids: ["x"], droppedTikTok: 0 });
  });

  it("is wired into the RSS auto-post (RSS drafts carry no video and no TikTok settings)", () => {
    const src = readFileSync(join(__dirname, "../workers/rss-sync.worker.ts"), "utf8");
    expect(src).toMatch(/withoutTikTokChannels\(/);
    expect(src).not.toMatch(/create: feed\.targetChannels\.map/);
  });
});
