import { describe, it, expect, vi, afterEach } from "vitest";

// buildScheduledPublishJobs (the web + cron producer) is exercised below; keep
// the real queue instances and their Redis connections out of the test.
vi.mock("./queues", () => ({ postPublishQueue: { add: vi.fn() } }));

import {
  computePublishDelays,
  resolvePlatformStaggerMs,
  staggerEnvKey,
  PLATFORM_STAGGER_MS,
  DEFAULT_STAGGER_MS,
  STAGGER_OVERRIDE_MIN_MS,
  STAGGER_OVERRIDE_MAX_MS,
} from "./publish-stagger";
import { buildScheduledPublishJobs } from "./schedule-publish";

describe("computePublishDelays", () => {
  it("gives the first target of EVERY platform delay 0 (all platforms start together)", () => {
    const delays = computePublishDelays([
      { platform: "FACEBOOK" },
      { platform: "TWITTER" },
      { platform: "TELEGRAM" },
      { platform: "YOUTUBE" },
    ]);
    expect(delays).toEqual([0, 0, 0, 0]);
  });

  it("staggers only within the same platform group", () => {
    const delays = computePublishDelays([
      { platform: "FACEBOOK" }, // fb #0
      { platform: "TELEGRAM" }, // tg #0
      { platform: "FACEBOOK" }, // fb #1 → 10s
      { platform: "TELEGRAM" }, // tg #1 → 2s
      { platform: "FACEBOOK" }, // fb #2 → 20s
    ]);
    expect(delays).toEqual([0, 0, 10_000, 2_000, 20_000]);
  });

  it("a 60-channel post spread across platforms no longer tails out ~10 minutes", () => {
    // 60 channels over 6 platforms (10 each) — worst per-platform tail is
    // 9 * stagger. Old behavior was a global 59 * 10s = 590s tail.
    const platforms = ["FACEBOOK", "INSTAGRAM", "TWITTER", "LINKEDIN", "TELEGRAM", "DISCORD"];
    const targets = Array.from({ length: 60 }, (_, i) => ({ platform: platforms[i % 6]! }));
    const delays = computePublishDelays(targets);
    expect(Math.max(...delays)).toBe(9 * 10_000); // 90s, was 590s
  });

  it("keeps the full 10s spacing for same-platform bursts (Meta/X shared-app quota)", () => {
    const targets = Array.from({ length: 5 }, () => ({ platform: "FACEBOOK" }));
    expect(computePublishDelays(targets)).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
  });

  it("falls back to the default stagger for unknown platforms", () => {
    const delays = computePublishDelays([
      { platform: "SOME_FUTURE_PLATFORM" },
      { platform: "SOME_FUTURE_PLATFORM" },
    ]);
    expect(delays).toEqual([0, DEFAULT_STAGGER_MS]);
  });

  it("returns an empty array for no targets", () => {
    expect(computePublishDelays([])).toEqual([]);
  });

  it("locks the strict tier for platforms with shared-app quotas", () => {
    for (const p of ["FACEBOOK", "INSTAGRAM", "THREADS", "TWITTER"]) {
      expect(PLATFORM_STAGGER_MS[p]).toBe(10_000);
    }
  });
});

// 2026-09-16: per-platform env override (PUBLISH_STAGGER_<PLATFORM>_MS). The
// table above stays the default; these lock the parsing so a typo in
// .env.prod can never collapse the spacing to 0 or blow it up to minutes.
describe("PUBLISH_STAGGER_<PLATFORM>_MS override", () => {
  const five = (platform: string, count: number) =>
    Array.from({ length: count }, () => ({ platform }));

  it("names the key after the platform enum value", () => {
    expect(staggerEnvKey("INSTAGRAM")).toBe("PUBLISH_STAGGER_INSTAGRAM_MS");
    expect(staggerEnvKey("FACEBOOK")).toBe("PUBLISH_STAGGER_FACEBOOK_MS");
  });

  it("an empty env leaves every table default untouched", () => {
    for (const [platform, ms] of Object.entries(PLATFORM_STAGGER_MS)) {
      expect(resolvePlatformStaggerMs(platform, {})).toBe(ms);
    }
    expect(resolvePlatformStaggerMs("SOME_FUTURE_PLATFORM", {})).toBe(DEFAULT_STAGGER_MS);
  });

  it("applies ONLY to the named platform", () => {
    const env = { PUBLISH_STAGGER_INSTAGRAM_MS: "5000" };
    const delays = computePublishDelays(
      [
        { platform: "INSTAGRAM" }, // ig #0
        { platform: "FACEBOOK" }, //  fb #0
        { platform: "INSTAGRAM" }, // ig #1 → 5s (override)
        { platform: "FACEBOOK" }, //  fb #1 → 10s (table default, untouched)
        { platform: "INSTAGRAM" }, // ig #2 → 10s
        { platform: "THREADS" }, //   th #0
        { platform: "THREADS" }, //   th #1 → 10s (shares the Meta tier, NOT the IG override)
      ],
      env
    );
    expect(delays).toEqual([0, 0, 5_000, 10_000, 10_000, 0, 10_000]);
  });

  it("keeps the first target of every platform at delay 0 under overrides", () => {
    const env = {
      PUBLISH_STAGGER_INSTAGRAM_MS: "2500",
      PUBLISH_STAGGER_FACEBOOK_MS: "60000",
      PUBLISH_STAGGER_TELEGRAM_MS: "1000",
    };
    const delays = computePublishDelays(
      [{ platform: "INSTAGRAM" }, { platform: "FACEBOOK" }, { platform: "TELEGRAM" }, { platform: "TWITTER" }],
      env
    );
    expect(delays).toEqual([0, 0, 0, 0]);
    expect(computePublishDelays(five("FACEBOOK", 3), env)).toEqual([0, 60_000, 120_000]);
  });

  it.each([
    ["", "empty — compose delivers an unset ${KEY:-} as \"\""],
    ["abc", "not a number"],
    ["-5", "negative"],
    [" 5000", "leading whitespace"],
    ["5000 ", "trailing whitespace"],
    ["5s", "unit suffix"],
    ["1e4", "exponent"],
    ["5000.5", "decimal"],
    ["0x1388", "hex"],
    ["+5000", "explicit sign"],
  ])("falls back to the table default for %j (%s)", (raw) => {
    const env = { PUBLISH_STAGGER_INSTAGRAM_MS: raw };
    expect(resolvePlatformStaggerMs("INSTAGRAM", env)).toBe(10_000);
    expect(computePublishDelays(five("INSTAGRAM", 3), env)).toEqual([0, 10_000, 20_000]);
  });

  it("clamps \"0\" UP to the floor — same-platform targets never share an instant", () => {
    const env = { PUBLISH_STAGGER_INSTAGRAM_MS: "0" };
    expect(resolvePlatformStaggerMs("INSTAGRAM", env)).toBe(STAGGER_OVERRIDE_MIN_MS);
    expect(computePublishDelays(five("INSTAGRAM", 3), env)).toEqual([0, 1_000, 2_000]);
    expect(resolvePlatformStaggerMs("INSTAGRAM", { PUBLISH_STAGGER_INSTAGRAM_MS: "999" })).toBe(1_000);
  });

  it("clamps an oversized value DOWN to the ceiling", () => {
    expect(resolvePlatformStaggerMs("INSTAGRAM", { PUBLISH_STAGGER_INSTAGRAM_MS: "999999" })).toBe(
      STAGGER_OVERRIDE_MAX_MS
    );
    // Absurdly long digit strings still land on the ceiling, never NaN/Infinity.
    expect(resolvePlatformStaggerMs("INSTAGRAM", { PUBLISH_STAGGER_INSTAGRAM_MS: "9".repeat(400) })).toBe(60_000);
  });

  it("honours the exact bounds and anything in between", () => {
    expect(resolvePlatformStaggerMs("FACEBOOK", { PUBLISH_STAGGER_FACEBOOK_MS: "1000" })).toBe(1_000);
    expect(resolvePlatformStaggerMs("FACEBOOK", { PUBLISH_STAGGER_FACEBOOK_MS: "60000" })).toBe(60_000);
    expect(resolvePlatformStaggerMs("FACEBOOK", { PUBLISH_STAGGER_FACEBOOK_MS: "007000" })).toBe(7_000);
  });

  it("an unknown platform can be tuned too, and otherwise uses the middle tier", () => {
    const env = { PUBLISH_STAGGER_SOME_FUTURE_PLATFORM_MS: "3000" };
    expect(computePublishDelays(five("SOME_FUTURE_PLATFORM", 2), env)).toEqual([0, 3_000]);
  });

  it("a prototype-member platform name never resolves to an Object.prototype value", () => {
    for (const p of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(resolvePlatformStaggerMs(p, {})).toBe(DEFAULT_STAGGER_MS);
      expect(computePublishDelays([{ platform: p }, { platform: p }], {})).toEqual([0, DEFAULT_STAGGER_MS]);
    }
  });

  describe("reads process.env when no env is passed (the production call shape)", () => {
    const KEY = "PUBLISH_STAGGER_INSTAGRAM_MS";
    const prev = process.env[KEY];
    afterEach(() => {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    });

    it("computePublishDelays(targets) picks the override up at CALL time", () => {
      delete process.env[KEY];
      expect(computePublishDelays(five("INSTAGRAM", 2))).toEqual([0, 10_000]);
      process.env[KEY] = "4000";
      expect(computePublishDelays(five("INSTAGRAM", 2))).toEqual([0, 4_000]);
      process.env[KEY] = "";
      expect(computePublishDelays(five("INSTAGRAM", 2))).toEqual([0, 10_000]);
    });

    it("buildScheduledPublishJobs (web save-time + worker cron) spaces by the override, jobIds unchanged", () => {
      const T0 = 1_800_000_000_000;
      const args = {
        postId: "p1",
        organizationId: "o1",
        scheduledAt: new Date(T0 + 60_000),
        now: T0,
        targets: [
          { id: "t1", channelId: "c1", platform: "INSTAGRAM" },
          { id: "t2", channelId: "c2", platform: "FACEBOOK" },
          { id: "t3", channelId: "c3", platform: "INSTAGRAM" },
          { id: "t4", channelId: "c4", platform: "FACEBOOK" },
        ],
      };
      delete process.env[KEY];
      const before = buildScheduledPublishJobs(args);
      process.env[KEY] = "5000";
      const after = buildScheduledPublishJobs(args);

      expect(before.map((j) => j.opts.delay)).toEqual([60_000, 60_000, 70_000, 70_000]);
      expect(after.map((j) => j.opts.delay)).toEqual([60_000, 60_000, 65_000, 70_000]);
      // The delay is NOT part of the id: if web and worker ever disagree on the
      // spacing, BullMQ still dedupes and the first producer's delay wins.
      expect(after.map((j) => j.opts.jobId)).toEqual(before.map((j) => j.opts.jobId));
      for (const j of after) expect(j.opts.jobId.split(":")).toHaveLength(3);
    });
  });
});
