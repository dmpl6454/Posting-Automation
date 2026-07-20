import { describe, it, expect, vi } from "vitest";

// Keep the real queue instances (and their Redis connections) out of the test.
vi.mock("./queues", () => ({ postPublishQueue: { add: vi.fn() } }));

import { buildScheduledPublishJobs } from "./schedule-publish";
import { PRIORITY_BULK } from "./publish-priority";

const T0 = 1_800_000_000_000; // fixed clock
const targets = [
  { id: "t1", channelId: "c1", platform: "FACEBOOK" },
  { id: "t2", channelId: "c2", platform: "TELEGRAM" },
  { id: "t3", channelId: "c3", platform: "FACEBOOK" },
];

describe("buildScheduledPublishJobs", () => {
  it("mints deterministic 3-segment jobIds keyed by target + scheduledAt epoch", () => {
    const jobs = buildScheduledPublishJobs({
      postId: "p1", organizationId: "o1",
      scheduledAt: new Date(T0 + 60_000), targets, now: T0,
    });
    expect(jobs.map((j) => j.opts.jobId)).toEqual([
      `sched:t1:${T0 + 60_000}`,
      `sched:t2:${T0 + 60_000}`,
      `sched:t3:${T0 + 60_000}`,
    ]);
    // Exactly three colon-separated segments — BullMQ rejects other counts.
    for (const j of jobs) expect(j.opts.jobId.split(":")).toHaveLength(3);
  });

  it("delays to the exact scheduled time plus the platform-group stagger", () => {
    const jobs = buildScheduledPublishJobs({
      postId: "p1", organizationId: "o1",
      scheduledAt: new Date(T0 + 90_000), targets, now: T0,
    });
    // fb#0 and tg#0 land exactly at the scheduled time; fb#1 waits its 10s stagger.
    expect(jobs.map((j) => j.opts.delay)).toEqual([90_000, 90_000, 100_000]);
  });

  it("clamps an overdue schedule to delay 0 (cron reconciliation path)", () => {
    const jobs = buildScheduledPublishJobs({
      postId: "p1", organizationId: "o1",
      scheduledAt: new Date(T0 - 45_000), targets, now: T0,
    });
    expect(jobs.map((j) => j.opts.delay)).toEqual([0, 0, 10_000]);
  });

  it("stamps enqueuedFor with the scheduledAt epoch and rides the bulk lane", () => {
    const scheduledAt = new Date(T0 + 5_000);
    const jobs = buildScheduledPublishJobs({
      postId: "p1", organizationId: "o1", scheduledAt, targets, now: T0,
    });
    for (const j of jobs) {
      expect(j.data.enqueuedFor).toBe(scheduledAt.getTime());
      expect(j.opts.priority).toBe(PRIORITY_BULK);
      expect(j.opts.attempts).toBe(3);
    }
    expect(jobs[0]!.data).toMatchObject({
      postId: "p1", postTargetId: "t1", channelId: "c1",
      platform: "FACEBOOK", organizationId: "o1",
    });
  });

  it("a reschedule mints DIFFERENT jobIds (epoch is part of the id)", () => {
    const a = buildScheduledPublishJobs({
      postId: "p1", organizationId: "o1",
      scheduledAt: new Date(T0 + 60_000), targets, now: T0,
    });
    const b = buildScheduledPublishJobs({
      postId: "p1", organizationId: "o1",
      scheduledAt: new Date(T0 + 120_000), targets, now: T0,
    });
    expect(a[0]!.opts.jobId).not.toBe(b[0]!.opts.jobId);
  });
});
