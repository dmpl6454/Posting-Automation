import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock ioredis before any imports that use it
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

// Now import the module under test after mocks are in place
import { QUEUE_NAMES } from "../queues";
import type {
  PostPublishJobData,
  TokenRefreshJobData,
  AnalyticsSyncJobData,
  MediaProcessJobData,
} from "../types";

describe("QUEUE_NAMES", () => {
  it("exports POST_PUBLISH as a non-empty string", () => {
    expect(QUEUE_NAMES.POST_PUBLISH).toBe("post-publish");
    expect(typeof QUEUE_NAMES.POST_PUBLISH).toBe("string");
    expect(QUEUE_NAMES.POST_PUBLISH.length).toBeGreaterThan(0);
  });

  it("exports TOKEN_REFRESH as a non-empty string", () => {
    expect(QUEUE_NAMES.TOKEN_REFRESH).toBe("token-refresh");
    expect(typeof QUEUE_NAMES.TOKEN_REFRESH).toBe("string");
    expect(QUEUE_NAMES.TOKEN_REFRESH.length).toBeGreaterThan(0);
  });

  it("exports ANALYTICS_SYNC as a non-empty string", () => {
    expect(QUEUE_NAMES.ANALYTICS_SYNC).toBe("analytics-sync");
    expect(typeof QUEUE_NAMES.ANALYTICS_SYNC).toBe("string");
    expect(QUEUE_NAMES.ANALYTICS_SYNC.length).toBeGreaterThan(0);
  });

  it("exports MEDIA_PROCESS as a non-empty string", () => {
    expect(QUEUE_NAMES.MEDIA_PROCESS).toBe("media-process");
    expect(typeof QUEUE_NAMES.MEDIA_PROCESS).toBe("string");
    expect(QUEUE_NAMES.MEDIA_PROCESS.length).toBeGreaterThan(0);
  });

  it("exports RSS_SYNC as a non-empty string", () => {
    expect(typeof QUEUE_NAMES.RSS_SYNC).toBe("string");
    expect(QUEUE_NAMES.RSS_SYNC.length).toBeGreaterThan(0);
  });

  it("exports NOTIFICATION_SEND as a non-empty string", () => {
    expect(typeof QUEUE_NAMES.NOTIFICATION_SEND).toBe("string");
    expect(QUEUE_NAMES.NOTIFICATION_SEND.length).toBeGreaterThan(0);
  });

  it("contains exactly 7 queue names", () => {
    const keys = Object.keys(QUEUE_NAMES);
    expect(keys).toHaveLength(7);
  });

  it("all queue names are unique", () => {
    const values = Object.values(QUEUE_NAMES);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});

describe("Job data types", () => {
  it("PostPublishJobData has the correct shape", () => {
    const jobData: PostPublishJobData = {
      postId: "post-123",
      postTargetId: "target-456",
      channelId: "channel-789",
      platform: "TWITTER",
      organizationId: "org-001",
    };

    expect(jobData.postId).toBe("post-123");
    expect(jobData.postTargetId).toBe("target-456");
    expect(jobData.channelId).toBe("channel-789");
    expect(jobData.platform).toBe("TWITTER");
    expect(jobData.organizationId).toBe("org-001");
  });

  it("TokenRefreshJobData has the correct shape", () => {
    const jobData: TokenRefreshJobData = {
      channelId: "channel-789",
      platform: "LINKEDIN",
    };

    expect(jobData.channelId).toBe("channel-789");
    expect(jobData.platform).toBe("LINKEDIN");
  });

  it("AnalyticsSyncJobData has the correct shape", () => {
    const jobData: AnalyticsSyncJobData = {
      postTargetId: "target-456",
      platform: "FACEBOOK",
      channelId: "channel-789",
      platformPostId: "fb-post-123",
    };

    expect(jobData.postTargetId).toBe("target-456");
    expect(jobData.platform).toBe("FACEBOOK");
    expect(jobData.channelId).toBe("channel-789");
    expect(jobData.platformPostId).toBe("fb-post-123");
  });

  it("MediaProcessJobData has the correct shape", () => {
    const jobData: MediaProcessJobData = {
      mediaId: "media-001",
      organizationId: "org-001",
      operation: "thumbnail",
    };

    expect(jobData.mediaId).toBe("media-001");
    expect(jobData.organizationId).toBe("org-001");
    expect(jobData.operation).toBe("thumbnail");
  });

  it("MediaProcessJobData operation accepts valid values", () => {
    const thumbnailJob: MediaProcessJobData = {
      mediaId: "m1",
      organizationId: "o1",
      operation: "thumbnail",
    };
    const resizeJob: MediaProcessJobData = {
      mediaId: "m2",
      organizationId: "o2",
      operation: "resize",
    };
    const optimizeJob: MediaProcessJobData = {
      mediaId: "m3",
      organizationId: "o3",
      operation: "optimize",
    };

    expect(thumbnailJob.operation).toBe("thumbnail");
    expect(resizeJob.operation).toBe("resize");
    expect(optimizeJob.operation).toBe("optimize");
  });
});
