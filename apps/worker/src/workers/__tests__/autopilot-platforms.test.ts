import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autopilotSkipReason } from "../autopilot-platforms";

/**
 * Autopilot (content-generate) and agents (agent-run) produce IMAGE posts with
 * nobody at the keyboard. TikTok (2026-10-28) is skipped for two reasons:
 * it posts video only, and TikTok's Content Sharing Guidelines require the
 * creator to choose each post's visibility and interactions themselves — there
 * is no default the product may pick. YouTube was already skipped (video only).
 */
describe("autopilotSkipReason", () => {
  it("skips YouTube and TikTok, with a reason for the log", () => {
    expect(autopilotSkipReason("YOUTUBE")).toBe("autopilot produces images, not video");
    expect(autopilotSkipReason("TIKTOK")).toMatch(/video/);
    expect(autopilotSkipReason("TIKTOK")).toMatch(/visibility/);
  });

  it.each(["INSTAGRAM", "FACEBOOK", "TWITTER", "LINKEDIN", "THREADS", "PINTEREST", "TELEGRAM"])(
    "keeps %s",
    (platform) => {
      expect(autopilotSkipReason(platform)).toBeNull();
    }
  );
});

describe("wiring — both unattended producers use it", () => {
  // Comments stripped so an explanatory note cannot satisfy or break a check.
  const source = (file: string) =>
    readFileSync(join(__dirname, "..", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it.each(["content-generate.worker.ts", "agent-run.worker.ts"])("%s skips through autopilotSkipReason before creating a target", (file) => {
    const src = source(file);
    const skipAt = src.indexOf("autopilotSkipReason(channel.platform)");
    expect(skipAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(src.indexOf("prisma.postTarget.create("));
    // The old YouTube-only check is gone — one rule, one place.
    expect(src).not.toMatch(/channel\.platform === "YOUTUBE"/);
  });
});
