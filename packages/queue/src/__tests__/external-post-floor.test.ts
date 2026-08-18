import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXTERNAL_POST_FLOOR_ISO,
  formatExternalPostFloor,
  resolveExternalPostFloor,
} from "../external-post-floor";

/**
 * The floor governs how much platform history Insights ingests. It used to be
 * hardcoded in three places; live probing on 2026-08-18 showed both Meta listing
 * edges happily return far older history, so it became configurable.
 *
 * The parsing must fail CLOSED. `docker-compose.prod.yml` uses an explicit
 * `environment:` allowlist, so an unplumbed key arrives as "" — and a fail-open
 * reading of "" would silently widen the window across every account at once,
 * multiplying the expensive metrics half of the sweep. That is the PR #166
 * incident pattern.
 */
describe("resolveExternalPostFloor", () => {
  const DEFAULT = new Date(DEFAULT_EXTERNAL_POST_FLOOR_ISO);

  it("defaults when unset — behaviour identical to the hardcoded constant", () => {
    expect(resolveExternalPostFloor(undefined)).toEqual(DEFAULT);
    expect(resolveExternalPostFloor(null)).toEqual(DEFAULT);
  });

  it("fails closed on the EMPTY STRING an unplumbed compose key produces", () => {
    expect(resolveExternalPostFloor("")).toEqual(DEFAULT);
    expect(resolveExternalPostFloor("   ")).toEqual(DEFAULT);
  });

  it("fails closed on garbage rather than widening the window", () => {
    expect(resolveExternalPostFloor("not-a-date")).toEqual(DEFAULT);
    expect(resolveExternalPostFloor("2026-13-45")).toEqual(DEFAULT);
  });

  it("accepts a deliberate earlier floor", () => {
    expect(resolveExternalPostFloor("2026-01-01T00:00:00.000Z")).toEqual(
      new Date("2026-01-01T00:00:00.000Z")
    );
  });

  it("rejects a FUTURE floor — it would collect nothing at all", () => {
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    expect(resolveExternalPostFloor(future)).toEqual(DEFAULT);
  });
});

describe("formatExternalPostFloor", () => {
  it("derives the UI label from the active floor, in UTC", () => {
    // Hardcoding this label is how the copy and the data drift apart.
    expect(formatExternalPostFloor(new Date("2026-08-01T00:00:00.000Z"))).toBe("1 Aug 2026");
    expect(formatExternalPostFloor(new Date("2025-11-21T16:00:00.000Z"))).toBe("21 Nov 2025");
  });

  it("keeps the shipped default label unchanged", () => {
    expect(formatExternalPostFloor(new Date(DEFAULT_EXTERNAL_POST_FLOOR_ISO))).toBe("1 Aug 2026");
  });
});

describe("resolveExternalPostFloor — strict shape (review finding)", () => {
  const DEFAULT = new Date(DEFAULT_EXTERNAL_POST_FLOOR_ISO);

  it("rejects a plausible-looking non-ISO typo instead of widening the window", () => {
    // `new Date("01-08-2026")` PARSES in V8 — which engine-dependently means
    // 1 Aug or 8 Jan. Accepting it would silently move the floor by months, and
    // widening is the direction that costs Graph calls on every account at once.
    for (const bad of ["01-08-2026", "08/01/2026", "August 2026", "2026", "2026-08", "next monday"]) {
      expect(resolveExternalPostFloor(bad), bad).toEqual(DEFAULT);
    }
  });

  it("accepts a bare ISO date and anchors it at UTC midnight", () => {
    expect(resolveExternalPostFloor("2026-05-01")).toEqual(new Date("2026-05-01T00:00:00.000Z"));
  });

  it("accepts full ISO timestamps with and without milliseconds", () => {
    expect(resolveExternalPostFloor("2026-05-01T06:30:00Z")).toEqual(new Date("2026-05-01T06:30:00Z"));
    expect(resolveExternalPostFloor("2026-05-01T06:30:00.250Z")).toEqual(
      new Date("2026-05-01T06:30:00.250Z")
    );
  });
});
