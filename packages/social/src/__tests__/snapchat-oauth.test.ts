import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock @postautomation/db to provide the SocialPlatform type
vi.mock("@postautomation/db", () => ({}));

import { SnapchatProvider } from "../providers/snapchat.provider";
import type { OAuthConfig } from "../abstract/social.types";

/** Helper to create a mock Response */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

const baseConfig: OAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  callbackUrl: "https://app.example.com/api/oauth/callback/snapchat",
  scopes: ["snapchat-profile-api"],
};

describe("OAuth Flow - Snapchat (connect-only)", () => {
  const snapchat = new SnapchatProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getOAuthUrl()", () => {
    it("points to Snapchat's accounts.snapchat.com authorize endpoint", () => {
      const url = snapchat.getOAuthUrl(baseConfig, "state");
      expect(url).toContain("https://accounts.snapchat.com/accounts/oauth2/auth");
    });

    it("includes client_id, encoded redirect_uri, state and response_type=code", () => {
      const url = snapchat.getOAuthUrl(baseConfig, "the-state");
      expect(url).toContain("client_id=test-client-id");
      expect(url).toContain(
        `redirect_uri=${encodeURIComponent("https://app.example.com/api/oauth/callback/snapchat")}`
      );
      expect(url).toContain("state=the-state");
      expect(url).toContain("response_type=code");
    });

    it("space-joins scopes (NOT comma-joined — that's Meta-specific)", () => {
      const url = snapchat.getOAuthUrl(
        { ...baseConfig, scopes: ["snapchat-profile-api", "extra-scope"] },
        "s"
      );
      // URLSearchParams encodes a space as "+"
      expect(url).toContain("scope=snapchat-profile-api+extra-scope");
      expect(url).not.toContain("%2C"); // no comma
    });
  });

  describe("exchangeCodeForTokens()", () => {
    it("exchanges an auth code for tokens via the Snap token endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "snap-access",
          refresh_token: "snap-refresh",
          expires_in: 3600,
          scope: "snapchat-profile-api",
        })
      );

      const tokens = await snapchat.exchangeCodeForTokens("the-code", baseConfig);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://accounts.snapchat.com/accounts/oauth2/token",
        expect.objectContaining({ method: "POST" })
      );
      expect(tokens.accessToken).toBe("snap-access");
      expect(tokens.refreshToken).toBe("snap-refresh");
      expect(tokens.scopes).toEqual(["snapchat-profile-api"]);
      expect(tokens.expiresAt).toBeInstanceOf(Date);
    });

    it("throws a clear, prefixed error on failure", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ error: "invalid_grant" }, 400));
      await expect(snapchat.exchangeCodeForTokens("bad", baseConfig)).rejects.toThrow(
        "Snapchat token exchange failed"
      );
    });
  });

  describe("refreshAccessToken()", () => {
    it("persists the ROTATED refresh_token from the response (not the old one)", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "new-access",
          refresh_token: "ROTATED-refresh",
          expires_in: 3600,
          scope: "snapchat-profile-api",
        })
      );

      const tokens = await snapchat.refreshAccessToken("old-refresh", baseConfig);
      expect(tokens.accessToken).toBe("new-access");
      // Snapchat rotates — must be the NEW token, never the old one.
      expect(tokens.refreshToken).toBe("ROTATED-refresh");
      expect(tokens.refreshToken).not.toBe("old-refresh");
    });

    it("falls back to the incoming refresh token only if the response omits one", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ access_token: "new-access", expires_in: 3600 })
      );
      const tokens = await snapchat.refreshAccessToken("old-refresh", baseConfig);
      expect(tokens.refreshToken).toBe("old-refresh");
    });
  });

  describe("getProfile()", () => {
    it("reads /public_profiles/my_profile and maps it to a SocialProfile", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          request_status: "SUCCESS",
          public_profile: {
            id: "d6ed1cac-e0cd-4109-bf04-539cb8591838",
            display_name: "Test Brand",
            snap_user_name: "test-brand",
            logo_urls: { original_logo_url: "https://cf-st.sc-cdn.net/logo.png" },
          },
        })
      );

      const profile = await snapchat.getProfile({ accessToken: "tok" });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://businessapi.snapchat.com/v1/public_profiles/my_profile",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        })
      );
      expect(profile.id).toBe("d6ed1cac-e0cd-4109-bf04-539cb8591838");
      expect(profile.name).toBe("Test Brand");
      expect(profile.username).toBe("test-brand");
      expect(profile.avatar).toBe("https://cf-st.sc-cdn.net/logo.png");
    });

    it("throws a clear error when the profile read fails (e.g. 403 before allowlist)", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error_code: "AUTHORIZATION_PERMISSION_DENIED" }, 403)
      );
      await expect(snapchat.getProfile({ accessToken: "tok" })).rejects.toThrow(
        "Snapchat profile fetch failed"
      );
    });
  });

  describe("posting is intentionally not available yet (connect-only slice)", () => {
    it("publishPost throws a clear 'not available yet' error, never silently succeeds", async () => {
      await expect(
        snapchat.publishPost({ accessToken: "tok" }, { content: "hi", mediaUrls: ["x"] })
      ).rejects.toThrow(/not available yet/i);
    });

    it("deletePost throws (Snapchat has no programmatic delete)", async () => {
      await expect(snapchat.deletePost({ accessToken: "tok" }, "post-id")).rejects.toThrow(
        /does not support programmatic post deletion/i
      );
    });

    it("getPostAnalytics returns null (inherited base contract — never throws in sync)", async () => {
      await expect(
        snapchat.getPostAnalytics({ accessToken: "tok" }, "post-id")
      ).resolves.toBeNull();
    });
  });
});
