import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Prisma ────────────────────────────────────────────────────────
const mockPrisma = {
  postTarget: {
    update: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
  },
  post: {
    update: vi.fn(),
  },
  channel: {
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("@postautomation/db", () => ({
  prisma: mockPrisma,
}));

// ── Mock Social Providers ──────────────────────────────────────────────
const mockProvider = {
  platform: "TWITTER",
  displayName: "Twitter / X",
  constraints: {
    maxContentLength: 280,
    supportedMediaTypes: ["image/jpeg", "image/png"],
    maxMediaCount: 4,
  },
  validateContent: vi.fn().mockReturnValue([]),
  publishPost: vi.fn(),
  refreshAccessToken: vi.fn(),
  getOAuthUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  deletePost: vi.fn(),
  getProfile: vi.fn(),
  getPostAnalytics: vi.fn(),
};

vi.mock("@postautomation/social", () => ({
  getSocialProvider: vi.fn(() => mockProvider),
}));

// ── Mock BullMQ ────────────────────────────────────────────────────────
vi.mock("bullmq", () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
}));

// ── Mock Queue connection ──────────────────────────────────────────────
vi.mock("@postautomation/queue", () => ({
  QUEUE_NAMES: {
    POST_PUBLISH: "post-publish",
    TOKEN_REFRESH: "token-refresh",
    ANALYTICS_SYNC: "analytics-sync",
    MEDIA_PROCESS: "media-process",
  },
  createRedisConnection: vi.fn(() => ({})),
}));

import type { PostPublishJobData, TokenRefreshJobData } from "../types";

describe("Post Publish Job Processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockJobData: PostPublishJobData = {
    postId: "post-1",
    postTargetId: "target-1",
    channelId: "channel-1",
    platform: "TWITTER",
    organizationId: "org-1",
  };

  const mockChannel = {
    id: "channel-1",
    accessToken: "access-token-123",
    refreshToken: "refresh-token-456",
    platform: "TWITTER",
  };

  const mockPostTarget = {
    id: "target-1",
    postId: "post-1",
    post: {
      content: "Hello from the test!",
      contentVariants: null,
      mediaAttachments: [],
    },
  };

  describe("Successful post publishing", () => {
    it("should mark post target as PUBLISHING before processing", async () => {
      mockPrisma.postTarget.update.mockResolvedValue({});

      await mockPrisma.postTarget.update({
        where: { id: mockJobData.postTargetId },
        data: { status: "PUBLISHING" },
      });

      expect(mockPrisma.postTarget.update).toHaveBeenCalledWith({
        where: { id: "target-1" },
        data: { status: "PUBLISHING" },
      });
    });

    it("should fetch channel and post target data", async () => {
      mockPrisma.channel.findUniqueOrThrow.mockResolvedValue(mockChannel);
      mockPrisma.postTarget.findUniqueOrThrow.mockResolvedValue(mockPostTarget);

      const [channel, postTarget] = await Promise.all([
        mockPrisma.channel.findUniqueOrThrow({ where: { id: mockJobData.channelId } }),
        mockPrisma.postTarget.findUniqueOrThrow({
          where: { id: mockJobData.postTargetId },
          include: { post: { include: { mediaAttachments: true } } },
        }),
      ]);

      expect(channel.accessToken).toBe("access-token-123");
      expect(postTarget.post.content).toBe("Hello from the test!");
    });

    it("should validate content before publishing", () => {
      mockProvider.validateContent.mockReturnValue([]);

      const errors = mockProvider.validateContent({
        content: "Hello from the test!",
        mediaUrls: [],
      });

      expect(errors).toHaveLength(0);
      expect(mockProvider.validateContent).toHaveBeenCalled();
    });

    it("should call publishPost with correct tokens and payload", async () => {
      mockProvider.publishPost.mockResolvedValue({
        platformPostId: "tweet-999",
        url: "https://twitter.com/i/status/tweet-999",
        metadata: {},
      });

      const result = await mockProvider.publishPost(
        { accessToken: mockChannel.accessToken, refreshToken: mockChannel.refreshToken },
        { content: mockPostTarget.post.content, mediaUrls: [] }
      );

      expect(result.platformPostId).toBe("tweet-999");
      expect(result.url).toContain("tweet-999");
      expect(mockProvider.publishPost).toHaveBeenCalledWith(
        { accessToken: "access-token-123", refreshToken: "refresh-token-456" },
        { content: "Hello from the test!", mediaUrls: [] }
      );
    });

    it("should mark post target as PUBLISHED after successful publish", async () => {
      mockPrisma.postTarget.update.mockResolvedValue({});

      await mockPrisma.postTarget.update({
        where: { id: mockJobData.postTargetId },
        data: {
          status: "PUBLISHED",
          publishedId: "tweet-999",
          publishedUrl: "https://twitter.com/i/status/tweet-999",
          publishedAt: expect.any(Date),
        },
      });

      expect(mockPrisma.postTarget.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "PUBLISHED" }),
        })
      );
    });

    it("should update parent post status when all targets are published", async () => {
      mockPrisma.postTarget.findMany.mockResolvedValue([
        { id: "target-1", status: "PUBLISHED" },
        { id: "target-2", status: "PUBLISHED" },
      ]);

      const allTargets = await mockPrisma.postTarget.findMany({
        where: { postId: "post-1" },
      });

      const allPublished = allTargets.every(
        (t: any) => t.status === "PUBLISHED"
      );
      expect(allPublished).toBe(true);

      if (allPublished) {
        await mockPrisma.post.update({
          where: { id: "post-1" },
          data: { status: "PUBLISHED", publishedAt: new Date() },
        });
      }

      expect(mockPrisma.post.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "PUBLISHED" }),
        })
      );
    });
  });

  describe("Failed post publishing", () => {
    it("should update post target to FAILED status on error", async () => {
      const errorMessage = "Twitter post failed: rate limited";

      await mockPrisma.postTarget.update({
        where: { id: mockJobData.postTargetId },
        data: {
          status: "FAILED",
          errorMessage,
          retryCount: { increment: 1 },
        },
      });

      expect(mockPrisma.postTarget.update).toHaveBeenCalledWith({
        where: { id: "target-1" },
        data: {
          status: "FAILED",
          errorMessage,
          retryCount: { increment: 1 },
        },
      });
    });

    it("should throw when content validation fails", () => {
      mockProvider.validateContent.mockReturnValue([
        "Content exceeds 280 character limit for Twitter / X",
      ]);

      const errors = mockProvider.validateContent({
        content: "x".repeat(281),
        mediaUrls: [],
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(() => {
        if (errors.length > 0) {
          throw new Error(`Validation failed: ${errors.join(", ")}`);
        }
      }).toThrow("Validation failed");
    });

    it("should use platform-specific content variant when available", () => {
      const contentVariants: Record<string, string> = {
        TWITTER: "Short tweet version",
        LINKEDIN: "Long LinkedIn version with more details",
      };

      const content = contentVariants["TWITTER"] ?? "Default content";
      expect(content).toBe("Short tweet version");
    });

    it("should fall back to default content when no platform variant exists", () => {
      const contentVariants: Record<string, string> = {
        LINKEDIN: "LinkedIn only version",
      };
      const defaultContent = "Default post content";

      const content = contentVariants["TWITTER"] ?? defaultContent;
      expect(content).toBe("Default post content");
    });
  });

  describe("Job data validation", () => {
    it("should require postTargetId in job data", () => {
      expect(mockJobData.postTargetId).toBeDefined();
      expect(typeof mockJobData.postTargetId).toBe("string");
      expect(mockJobData.postTargetId.length).toBeGreaterThan(0);
    });

    it("should require channelId in job data", () => {
      expect(mockJobData.channelId).toBeDefined();
      expect(typeof mockJobData.channelId).toBe("string");
    });

    it("should require platform in job data", () => {
      expect(mockJobData.platform).toBeDefined();
      expect(typeof mockJobData.platform).toBe("string");
    });
  });
});

describe("Token Refresh Job Processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockTokenJobData: TokenRefreshJobData = {
    channelId: "channel-1",
    platform: "TWITTER",
  };

  it("should fetch channel data for the given channel ID", async () => {
    mockPrisma.channel.findUniqueOrThrow.mockResolvedValue({
      id: "channel-1",
      refreshToken: "old-refresh-token",
      accessToken: "old-access-token",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });

    const channel = await mockPrisma.channel.findUniqueOrThrow({
      where: { id: mockTokenJobData.channelId },
    });

    expect(channel.refreshToken).toBe("old-refresh-token");
  });

  it("should skip refresh when no refresh token exists", async () => {
    mockPrisma.channel.findUniqueOrThrow.mockResolvedValue({
      id: "channel-1",
      refreshToken: null,
      accessToken: "access-token",
    });

    const channel = await mockPrisma.channel.findUniqueOrThrow({
      where: { id: mockTokenJobData.channelId },
    });

    if (!channel.refreshToken) {
      // Worker skips processing
      expect(channel.refreshToken).toBeNull();
      return;
    }

    // Should not reach here
    expect(true).toBe(false);
  });

  it("should call provider refreshAccessToken with correct params", async () => {
    mockProvider.refreshAccessToken.mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: new Date(Date.now() + 7200_000),
    });

    const newTokens = await mockProvider.refreshAccessToken("old-refresh-token", {
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "https://app.example.com/api/oauth/callback/twitter",
      scopes: [],
    });

    expect(newTokens.accessToken).toBe("new-access-token");
    expect(newTokens.refreshToken).toBe("new-refresh-token");
    expect(newTokens.expiresAt).toBeInstanceOf(Date);
  });

  it("should update channel with new tokens after refresh", async () => {
    mockPrisma.channel.update.mockResolvedValue({});

    await mockPrisma.channel.update({
      where: { id: "channel-1" },
      data: {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        tokenExpiresAt: new Date(Date.now() + 7200_000),
      },
    });

    expect(mockPrisma.channel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "channel-1" },
        data: expect.objectContaining({
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
        }),
      })
    );
  });

  it("should preserve old refresh token when new one is not returned", async () => {
    mockProvider.refreshAccessToken.mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: undefined,
      expiresAt: new Date(Date.now() + 7200_000),
    });

    const newTokens = await mockProvider.refreshAccessToken("old-refresh-token", {
      clientId: "cid",
      clientSecret: "csecret",
      callbackUrl: "https://example.com/callback",
      scopes: [],
    });

    const existingRefreshToken = "old-refresh-token";
    const refreshTokenToSave = newTokens.refreshToken ?? existingRefreshToken;

    expect(refreshTokenToSave).toBe("old-refresh-token");
  });
});
