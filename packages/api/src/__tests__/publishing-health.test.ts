import { describe, expect, it, vi } from "vitest";

vi.mock("@postautomation/db", () => ({ prisma: {} }));
vi.mock("@postautomation/queue", async () => {
  const real = await vi.importActual<typeof import("../../../queue/src/publishing-health")>(
    "../../../queue/src/publishing-health"
  );
  return { ...real, redisConnection: {} };
});

import { computePublishingHealth } from "../lib/publishing-health";
import {
  nextAlertAction,
  alertRecipients,
  buildAlertEmail,
  CONSECUTIVE_BAD,
  REPEAT_MS,
  type AlertState,
} from "../lib/publishing-alerts";

const NOW = Date.UTC(2026, 10, 12, 3, 0, 0);

describe("computePublishingHealth", () => {
  it("combines a fresh heartbeat and zero overdue into ok", async () => {
    const h = await computePublishingHealth({
      now: () => NOW,
      readHeartbeat: async () => String(NOW - 10_000),
      readOverdue: async () => ({ count: 0, oldest: null }),
    });
    expect(h.status).toBe("ok");
  });

  it("asks only for posts more than 10 minutes late", async () => {
    const readOverdue = vi.fn().mockResolvedValue({ count: 0, oldest: null });
    await computePublishingHealth({ now: () => NOW, readHeartbeat: async () => String(NOW), readOverdue });
    expect((readOverdue.mock.calls[0]![0] as Date).getTime()).toBe(NOW - 10 * 60_000);
  });

  it("a hung Redis read is bounded and reported as down, never hangs", async () => {
    vi.useFakeTimers();
    const p = computePublishingHealth({
      now: () => NOW,
      readHeartbeat: () => new Promise(() => {}),
      readOverdue: async () => ({ count: 0, oldest: null }),
    });
    await vi.advanceTimersByTimeAsync(2_100);
    const h = await p;
    vi.useRealTimers();
    expect(h.status).toBe("down");
  });

  it("never throws when both reads fail", async () => {
    const h = await computePublishingHealth({
      now: () => NOW,
      readHeartbeat: async () => {
        throw new Error("redis");
      },
      readOverdue: async () => {
        throw new Error("db");
      },
    });
    expect(h.status).toBe("unknown");
  });
});

describe("nextAlertAction", () => {
  const fresh: AlertState = { badStreak: 0, alertedAt: null };

  it("one bad check does not alert (a deploy blip)", () => {
    expect(nextAlertAction(fresh, { status: "down" }, NOW).action).toBe("none");
  });

  it(`alerts after ${CONSECUTIVE_BAD} bad checks in a row`, () => {
    let s = fresh;
    let action: string = "none";
    for (let i = 0; i < CONSECUTIVE_BAD; i++) {
      const r = nextAlertAction(s, { status: "down" }, NOW + i);
      s = r.state;
      action = r.action;
    }
    expect(action).toBe("alert");
    expect(s.alertedAt).not.toBeNull();
  });

  it("does not repeat until REPEAT_MS has passed, then repeats", () => {
    const s = { badStreak: 5, alertedAt: NOW };
    expect(nextAlertAction(s, { status: "down" }, NOW + 60_000).action).toBe("none");
    expect(nextAlertAction(s, { status: "down" }, NOW + REPEAT_MS).action).toBe("alert");
  });

  it("sends one recovery after an alert, nothing when no alert was sent", () => {
    expect(nextAlertAction({ badStreak: 3, alertedAt: NOW }, { status: "ok" }, NOW).action).toBe("recover");
    expect(nextAlertAction({ badStreak: 1, alertedAt: null }, { status: "ok" }, NOW).action).toBe("none");
  });

  it("unknown and delayed count as bad", () => {
    const r1 = nextAlertAction({ badStreak: CONSECUTIVE_BAD - 1, alertedAt: null }, { status: "unknown" }, NOW);
    expect(r1.action).toBe("alert");
    const r2 = nextAlertAction({ badStreak: CONSECUTIVE_BAD - 1, alertedAt: null }, { status: "delayed" }, NOW);
    expect(r2.action).toBe("alert");
  });
});

describe("alertRecipients", () => {
  it("merges super admins with the env list, dedupes, drops junk", () => {
    expect(alertRecipients(["A@x.com", "b@y.com"], " a@x.com, ops@z.com ,nope,")).toEqual([
      "a@x.com",
      "b@y.com",
      "ops@z.com",
    ]);
    expect(alertRecipients([], undefined)).toEqual([]);
  });
});

describe("buildAlertEmail", () => {
  it("says posts are not publishing and how to look", () => {
    const e = buildAlertEmail("alert", {
      status: "down",
      reason: "The publishing worker last ran 40 min ago.",
      heartbeatAgeSec: 2400,
      overduePosts: 12,
      oldestOverdueMinutes: 35,
    });
    expect(e.subject).toMatch(/NOT publishing/);
    expect(e.text).toContain("Scheduled posts past their time: 12");
    expect(e.text).toContain("docker logs postautomation-worker-1");
  });

  it("recovery email", () => {
    const e = buildAlertEmail("recover", {
      status: "ok",
      reason: "",
      heartbeatAgeSec: 1,
      overduePosts: 0,
      oldestOverdueMinutes: null,
    });
    expect(e.subject).toMatch(/resumed/);
  });
});
