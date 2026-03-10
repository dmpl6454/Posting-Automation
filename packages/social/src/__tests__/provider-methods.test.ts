import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock @postautomation/db to provide SocialPlatform type
vi.mock("@postautomation/db", () => ({
  // The providers only use the SocialPlatform type, so we just need the module to resolve
}));

import { TwitterProvider } from "../providers/twitter.provider";
import { LinkedInProvider } from "../providers/linkedin.provider";
import type {
  OAuthConfig,
  OAuthTokens,
  SocialPostPayload,
} from "../abstract/social.types";

describe("Social Provider Methods", () => {
  const twitterProvider = new TwitterProvider();
  const linkedInProvider = new LinkedInProvider();

  const mockTokens: OAuthTokens = {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: new Date(Date.now() + 3600_000),
  };

  const mockOAuthConfig: OAuthConfig = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    callbackUrl: "https://app.example.com/api/oauth/callback/twitter",
    scopes: ["tweet.read", "tweet.write", "users.read"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Content Validation - Character Limits", () => {
    it("should pass validation for Twitter content within 280 characters", () => {
      const payload: SocialPostPayload = {
        content: "Hello World! This is a test tweet.",
      };
      const errors = twitterProvider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });

    it("should fail validation for Twitter content exceeding 280 characters", () => {
      const payload: SocialPostPayload = {
        content: "x".repeat(281),
      };
      const errors = twitterProvider.validateContent(payload);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("280");
      expect(errors[0]).toContain("Twitter");
    });

    it("should pass validation for LinkedIn content within 3000 characters", () => {
      const payload: SocialPostPayload = {
        content: "x".repeat(3000),
      };
      const errors = linkedInProvider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });

    it("should fail validation for LinkedIn content exceeding 3000 characters", () => {
      const payload: SocialPostPayload = {
        content: "x".repeat(3001),
      };
      const errors = linkedInProvider.validateContent(payload);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("3000");
    });

    it("should pass validation for content at exact character limit", () => {
      const payload: SocialPostPayload = {
        content: "x".repeat(280),
      };
      const errors = twitterProvider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });
  });

  describe("Content Validation - Media Limits", () => {
    it("should pass validation for Twitter with up to 4 media items", () => {
      const payload: SocialPostPayload = {
        content: "Post with media",
        mediaUrls: ["img1.jpg", "img2.jpg", "img3.jpg", "img4.jpg"],
      };
      const errors = twitterProvider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });

    it("should fail validation for Twitter with more than 4 media items", () => {
      const payload: SocialPostPayload = {
        content: "Post with too many media",
        mediaUrls: ["img1.jpg", "img2.jpg", "img3.jpg", "img4.jpg", "img5.jpg"],
      };
      const errors = twitterProvider.validateContent(payload);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("max 4");
    });

    it("should allow up to 20 media items for LinkedIn", () => {
      const payload: SocialPostPayload = {
        content: "Post with media",
        mediaUrls: Array.from({ length: 20 }, (_, i) => `img${i}.jpg`),
      };
      const errors = linkedInProvider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });

    it("should return multiple errors for both content and media violations", () => {
      const payload: SocialPostPayload = {
        content: "x".repeat(281),
        mediaUrls: ["img1.jpg", "img2.jpg", "img3.jpg", "img4.jpg", "img5.jpg"],
      };
      const errors = twitterProvider.validateContent(payload);
      expect(errors).toHaveLength(2);
    });
  });

  describe("OAuth URL Generation", () => {
    it("should generate a valid Twitter OAuth URL", () => {
      const url = twitterProvider.getOAuthUrl(mockOAuthConfig, "test-state");

      expect(url).toContain("https://twitter.com/i/oauth2/authorize");
      expect(url).toContain("client_id=test-client-id");
      expect(url).toContain("state=test-state");
      expect(url).toContain("response_type=code");
      expect(url).toContain("redirect_uri=");
    });

    it("should generate a valid LinkedIn OAuth URL", () => {
      const linkedInConfig: OAuthConfig = {
        ...mockOAuthConfig,
        callbackUrl: "https://app.example.com/api/oauth/callback/linkedin",
        scopes: ["openid", "profile", "w_member_social"],
      };

      const url = linkedInProvider.getOAuthUrl(linkedInConfig, "linkedin-state");

      expect(url).toContain("https://www.linkedin.com/oauth/v2/authorization");
      expect(url).toContain("client_id=test-client-id");
      expect(url).toContain("state=linkedin-state");
    });

    it("should include scopes in the OAuth URL", () => {
      const url = twitterProvider.getOAuthUrl(mockOAuthConfig, "test-state");
      // Scopes are joined with space and URL-encoded
      expect(url).toContain("scope=");
    });
  });

  describe("Platform Constraints", () => {
    it("should expose correct constraints for Twitter", () => {
      expect(twitterProvider.constraints.maxContentLength).toBe(280);
      expect(twitterProvider.constraints.maxMediaCount).toBe(4);
      expect(twitterProvider.constraints.supportsThreads).toBe(true);
      expect(twitterProvider.constraints.supportedMediaTypes).toContain("image/jpeg");
      expect(twitterProvider.constraints.supportedMediaTypes).toContain("video/mp4");
    });

    it("should expose correct constraints for LinkedIn", () => {
      expect(linkedInProvider.constraints.maxContentLength).toBe(3000);
      expect(linkedInProvider.constraints.maxMediaCount).toBe(20);
      expect(linkedInProvider.constraints.supportedMediaTypes).toContain("image/png");
    });

    it("should have supported media types as a non-empty array", () => {
      expect(twitterProvider.constraints.supportedMediaTypes.length).toBeGreaterThan(0);
      expect(linkedInProvider.constraints.supportedMediaTypes.length).toBeGreaterThan(0);
    });
  });

  describe("Token Exchange", () => {
    it("should exchange code for tokens on successful response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 7200,
            scope: "tweet.read tweet.write",
          }),
      });

      const tokens = await twitterProvider.exchangeCodeForTokens(
        "auth-code-123",
        mockOAuthConfig
      );

      expect(tokens.accessToken).toBe("new-access-token");
      expect(tokens.refreshToken).toBe("new-refresh-token");
      expect(tokens.expiresAt).toBeInstanceOf(Date);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should throw an error on failed token exchange", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () =>
          Promise.resolve({ error: "invalid_grant", error_description: "Bad code" }),
      });

      await expect(
        twitterProvider.exchangeCodeForTokens("bad-code", mockOAuthConfig)
      ).rejects.toThrow("Twitter token exchange failed");
    });
  });

  describe("Token Refresh", () => {
    it("should refresh access token successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "refreshed-access-token",
            refresh_token: "refreshed-refresh-token",
            expires_in: 7200,
          }),
      });

      const tokens = await twitterProvider.refreshAccessToken(
        "old-refresh-token",
        mockOAuthConfig
      );

      expect(tokens.accessToken).toBe("refreshed-access-token");
      expect(tokens.refreshToken).toBe("refreshed-refresh-token");
    });

    it("should throw error on refresh failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () =>
          Promise.resolve({ error: "invalid_grant" }),
      });

      await expect(
        twitterProvider.refreshAccessToken("expired-token", mockOAuthConfig)
      ).rejects.toThrow("Twitter token refresh failed");
    });
  });

  describe("Publish Post", () => {
    it("should publish a text-only post successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { id: "tweet-123", text: "Hello world" },
          }),
      });

      const result = await twitterProvider.publishPost(mockTokens, {
        content: "Hello world",
      });

      expect(result.platformPostId).toBe("tweet-123");
      expect(result.url).toContain("tweet-123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should throw error on publish failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () =>
          Promise.resolve({ errors: [{ message: "Duplicate tweet" }] }),
      });

      await expect(
        twitterProvider.publishPost(mockTokens, { content: "Hello world" })
      ).rejects.toThrow("Twitter post failed");
    });
  });

  describe("Get Profile", () => {
    it("should fetch profile successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              id: "user-42",
              name: "Test User",
              username: "testuser",
              profile_image_url: "https://pbs.twimg.com/avatar.jpg",
            },
          }),
      });

      const profile = await twitterProvider.getProfile(mockTokens);

      expect(profile.id).toBe("user-42");
      expect(profile.name).toBe("Test User");
      expect(profile.username).toBe("testuser");
    });

    it("should throw error on profile fetch failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ errors: [{ message: "Unauthorized" }] }),
      });

      await expect(twitterProvider.getProfile(mockTokens)).rejects.toThrow(
        "Twitter profile fetch failed"
      );
    });
  });
});
