import { describe, expect, it, vi } from "vitest";
import {
  evaluatePublishingHealth,
  parseHeartbeat,
  recordPublishHeartbeat,
  PUBLISH_HEARTBEAT_KEY,
  PUBLISH_HEARTBEAT_TTL_S,
  HEARTBEAT_STALE_MS,
} from "../publishing-health";

const NOW = Date.UTC(2026, 10, 12, 3, 0, 0);

describe("evaluatePublishingHealth", () => {
  it("ok when the scan ran recently and nothing is overdue", () => {
    const h = evaluatePublishingHealth({ now: NOW, heartbeatAt: NOW - 20_000, overduePosts: 0 });
    expect(h.status).toBe("ok");
    expect(h.heartbeatAgeSec).toBe(20);
  });

  it("down when the heartbeat is stale (the 2026-11-10 crash loop)", () => {
    const h = evaluatePublishingHealth({ now: NOW, heartbeatAt: NOW - HEARTBEAT_STALE_MS - 1, overduePosts: 0 });
    expect(h.status).toBe("down");
  });

  it("down when there is no heartbeat at all", () => {
    expect(evaluatePublishingHealth({ now: NOW, heartbeatAt: null, overduePosts: 0 }).status).toBe("down");
  });

  it("down when Redis cannot be read (publishing runs through it)", () => {
    expect(evaluatePublishingHealth({ now: NOW, heartbeatAt: undefined, overduePosts: 0 }).status).toBe("down");
  });

  it("delayed when the scan runs but posts sit past their time", () => {
    const h = evaluatePublishingHealth({
      now: NOW,
      heartbeatAt: NOW - 10_000,
      overduePosts: 3,
      oldestOverdueAt: NOW - 45 * 60_000,
    });
    expect(h.status).toBe("delayed");
    expect(h.oldestOverdueMinutes).toBe(45);
  });

  it("stale heartbeat outranks overdue posts", () => {
    const h = evaluatePublishingHealth({ now: NOW, heartbeatAt: NOW - 60 * 60_000, overduePosts: 12 });
    expect(h.status).toBe("down");
  });

  it("unknown only when neither Redis nor the database could be read", () => {
    expect(evaluatePublishingHealth({ now: NOW, heartbeatAt: undefined, overduePosts: undefined }).status).toBe("unknown");
  });

  it("an unreadable database with a fresh heartbeat is still ok (scan proves it)", () => {
    expect(evaluatePublishingHealth({ now: NOW, heartbeatAt: NOW - 5_000, overduePosts: undefined }).status).toBe("ok");
  });
});

describe("parseHeartbeat", () => {
  it("parses epoch ms and rejects garbage", () => {
    expect(parseHeartbeat(String(NOW))).toBe(NOW);
    expect(parseHeartbeat(null)).toBeNull();
    expect(parseHeartbeat("")).toBeNull();
    expect(parseHeartbeat("abc")).toBeNull();
    expect(parseHeartbeat("-5")).toBeNull();
  });
});

describe("recordPublishHeartbeat", () => {
  it("writes the key with a TTL", () => {
    const set = vi.fn().mockResolvedValue("OK");
    recordPublishHeartbeat({ set }, NOW);
    expect(set).toHaveBeenCalledWith(PUBLISH_HEARTBEAT_KEY, String(NOW), "EX", PUBLISH_HEARTBEAT_TTL_S);
  });

  it("never throws, sync or async", () => {
    expect(() => recordPublishHeartbeat({ set: () => { throw new Error("x"); } })).not.toThrow();
    expect(() => recordPublishHeartbeat({ set: () => Promise.reject(new Error("x")) })).not.toThrow();
  });
});
