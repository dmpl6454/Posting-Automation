import { describe, it, expect, vi } from "vitest";

// Mock ioredis before any imports that use it (mirrors queues.test.ts so no
// real Redis connection is opened at import time — both the queue's BullMQ
// connection and the progress helper's pub client use ioredis).
vi.mock("ioredis", () => {
  const MockIORedis = vi.fn().mockImplementation(() => ({
    status: "ready",
    connect: vi.fn(),
    disconnect: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  }));
  return { default: MockIORedis };
});

// Mock bullmq Queue so it does not attempt a real Redis connection
vi.mock("bullmq", () => {
  const MockQueue = vi.fn().mockImplementation((name: string) => ({
    name,
    add: vi.fn(),
    close: vi.fn(),
    getJobCounts: vi.fn(),
  }));
  return { Queue: MockQueue };
});

import { QUEUE_NAMES, repurposeVideoQueue, scopedProgressId } from "../index";
import type { RepurposeVideoJobData } from "../types";

describe("repurposeVideoQueue", () => {
  it("exposes REPURPOSE_VIDEO queue name", () => {
    expect(QUEUE_NAMES.REPURPOSE_VIDEO).toBe("repurpose-video");
  });

  it("is defined and has an .add function", () => {
    expect(repurposeVideoQueue).toBeDefined();
    expect(typeof repurposeVideoQueue.add).toBe("function");
  });

  it("accepts a reel RepurposeVideoJobData shape", () => {
    const job: RepurposeVideoJobData = {
      userId: "u1",
      organizationId: "org1",
      progressId: "u1:rep-1",
      format: "reel",
      theme: "dark",
      reel: {
        slideUrls: ["https://s3/slide-0.png", "https://s3/slide-1.png"],
        voiceOver: true,
        bgMusic: false,
        voiceType: "nova",
        voiceScript: "narration text",
      },
    };
    expect(job.reel?.slideUrls).toHaveLength(2);
    expect(job.format).toBe("reel");
  });

  it("accepts a seedance RepurposeVideoJobData shape", () => {
    const job: RepurposeVideoJobData = {
      userId: "u1",
      organizationId: "org1",
      progressId: "u1:rep-2",
      format: "seedance_video",
      theme: "gradient",
      seedance: {
        scenes: ["point one", "point two"],
        title: "Headline",
        description: "Body",
        duration: 8,
      },
    };
    expect(job.seedance?.scenes).toHaveLength(2);
    expect(job.format).toBe("seedance_video");
  });
});

describe("progress helper re-exported from @postautomation/queue", () => {
  it("scopedProgressId namespaces the id by userId", () => {
    expect(scopedProgressId("u1", "rep-x")).toBe("u1:rep-x");
  });
});
