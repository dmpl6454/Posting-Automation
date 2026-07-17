import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock @postautomation/db to provide the SocialPlatform type
vi.mock("@postautomation/db", () => ({}));

import { TwitterProvider } from "../providers/twitter.provider";
import { LinkedInProvider } from "../providers/linkedin.provider";
import { FacebookProvider } from "../providers/facebook.provider";
import { DiscordProvider } from "../providers/discord.provider";
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

/** Shared OAuth config for tests */
const baseConfig: OAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  callbackUrl: "https://app.example.com/callback",
  scopes: ["read", "write"],
};

// Twitter migrated to OAuth 1.0a — getOAuthUrl makes a live API call to obtain a request_token
// and cannot be unit-tested without real consumer credentials. All Twitter OAuth flow tests
// are skipped until an integration test environment with credentials is available.
describe.skip("OAuth Flow - Twitter (OAuth 1.0a — requires live credentials)", () => {
  const twitter = new TwitterProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getOAuthUrl()", () => {
    it("redirects to api.twitter.com/oauth/authorize after requesting a request_token", async () => {});
  });

  describe("exchangeCodeForTokens()", () => {
    it("exchanges oauth_verifier + request_token for access tokens via OAuth 1.0a", async () => {});
  });

  describe("refreshAccessToken()", () => {
    it("OAuth 1.0a access tokens do not expire — no-op", async () => {});
  });
});

describe("OAuth Flow - LinkedIn", () => {
  const linkedin = new LinkedInProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getOAuthUrl()", () => {
    it("should return a URL pointing to linkedin.com OAuth2 authorization", () => {
      const url = linkedin.getOAuthUrl(baseConfig, "state");
      expect(url).toContain("https://www.linkedin.com/oauth/v2/authorization");
    });

    it("should include client_id and redirect_uri", () => {
      const url = linkedin.getOAuthUrl(baseConfig, "state");
      expect(url).toContain("client_id=test-client-id");
      expect(url).toContain(
        `redirect_uri=${encodeURIComponent("https://app.example.com/callback")}`
      );
    });

    it("should include scopes joined by space", () => {
      const url = linkedin.getOAuthUrl(baseConfig, "s");
      expect(url).toContain("scope=read+write");
    });
  });

  describe("exchangeCodeForTokens()", () => {
    it("should exchange code for tokens via LinkedIn API", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "li-access",
          refresh_token: "li-refresh",
          expires_in: 5184000,
          scope: "r_liteprofile,w_member_social",
        })
      );

      const tokens = await linkedin.exchangeCodeForTokens("li-code", baseConfig);

      expect(tokens.accessToken).toBe("li-access");
      expect(tokens.refreshToken).toBe("li-refresh");
      expect(tokens.scopes).toEqual(["r_liteprofile", "w_member_social"]);
    });

    it("should throw when LinkedIn returns an error", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: "invalid_grant" }, 400)
      );

      await expect(
        linkedin.exchangeCodeForTokens("bad", baseConfig)
      ).rejects.toThrow("LinkedIn token exchange failed");
    });
  });

  describe("refreshAccessToken()", () => {
    it("should refresh LinkedIn access token", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "new-li-access",
          refresh_token: "new-li-refresh",
          expires_in: 5184000,
        })
      );

      const tokens = await linkedin.refreshAccessToken("old-refresh", baseConfig);

      expect(tokens.accessToken).toBe("new-li-access");
    });

    it("should throw on refresh failure", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: "expired_token" }, 401)
      );

      await expect(
        linkedin.refreshAccessToken("expired", baseConfig)
      ).rejects.toThrow("LinkedIn token refresh failed");
    });
  });
});

describe("OAuth Flow - Facebook", () => {
  const facebook = new FacebookProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getOAuthUrl()", () => {
    it("should return a URL pointing to facebook.com dialog/oauth", () => {
      const url = facebook.getOAuthUrl(baseConfig, "state");
      expect(url).toContain("https://www.facebook.com/");
      expect(url).toContain("/dialog/oauth");
    });

    it("should include scopes joined by comma", () => {
      const url = facebook.getOAuthUrl(baseConfig, "s");
      // Facebook uses comma-separated scopes
      expect(url).toContain("scope=read%2Cwrite");
    });

    it("should include state and client_id parameters", () => {
      const url = facebook.getOAuthUrl(baseConfig, "fb-state");
      expect(url).toContain("state=fb-state");
      expect(url).toContain("client_id=test-client-id");
    });

    // Regression (2026-07-17): returning users saw the "Continue as … / use
    // previous settings" shortcut, which silently reused a prior grant that may
    // have selected 0 Pages → me/accounts=[] → confusing fb_no_pages toast even
    // for users who DO admin a Page. auth_type=rerequest forces Facebook to
    // re-present the permission + Page-selection wizard. Do NOT remove.
    it("should include auth_type=rerequest to force the Page-selection wizard", () => {
      const url = facebook.getOAuthUrl(baseConfig, "s");
      expect(url).toContain("auth_type=rerequest");
    });
  });

  describe("exchangeCodeForTokens()", () => {
    it("should exchange code and then get a long-lived token", async () => {
      // First call: short-lived token exchange
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "short-lived-token",
          token_type: "bearer",
        })
      );
      // Second call: long-lived token exchange
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "long-lived-token",
          expires_in: 5184000,
          token_type: "bearer",
        })
      );

      const tokens = await facebook.exchangeCodeForTokens("fb-code", baseConfig);

      expect(tokens.accessToken).toBe("long-lived-token");
      // Facebook stores access_token as refresh token too
      expect(tokens.refreshToken).toBe("long-lived-token");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should throw when initial token exchange fails", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: { message: "invalid code" } }, 400)
      );

      await expect(
        facebook.exchangeCodeForTokens("bad-code", baseConfig)
      ).rejects.toThrow("Facebook token exchange failed");
    });
  });

  describe("refreshAccessToken()", () => {
    it("should exchange existing long-lived token for a new one", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "refreshed-long-lived-token",
          expires_in: 5184000,
        })
      );

      const tokens = await facebook.refreshAccessToken(
        "current-long-lived-token",
        baseConfig
      );

      expect(tokens.accessToken).toBe("refreshed-long-lived-token");
    });

    it("should throw when long-lived token exchange fails", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: { message: "expired" } }, 400)
      );

      await expect(
        facebook.refreshAccessToken("expired-token", baseConfig)
      ).rejects.toThrow("Facebook long-lived token exchange failed");
    });
  });
});

describe("OAuth Flow - Discord", () => {
  const discord = new DiscordProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getOAuthUrl()", () => {
    it("should return a URL pointing to discord.com/oauth2/authorize", () => {
      const url = discord.getOAuthUrl(baseConfig, "state");
      expect(url).toContain("https://discord.com/oauth2/authorize");
    });

    it("should include scopes joined by space", () => {
      const url = discord.getOAuthUrl(baseConfig, "s");
      expect(url).toContain("scope=read+write");
    });

    it("should include state and client_id", () => {
      const url = discord.getOAuthUrl(baseConfig, "disc-state");
      expect(url).toContain("state=disc-state");
      expect(url).toContain("client_id=test-client-id");
    });

    it("should include response_type=code", () => {
      const url = discord.getOAuthUrl(baseConfig, "s");
      expect(url).toContain("response_type=code");
    });
  });

  describe("exchangeCodeForTokens()", () => {
    it("should exchange code for tokens via Discord API", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "disc-access",
          refresh_token: "disc-refresh",
          expires_in: 604800,
          scope: "identify guilds",
        })
      );

      const tokens = await discord.exchangeCodeForTokens("disc-code", baseConfig);

      expect(tokens.accessToken).toBe("disc-access");
      expect(tokens.refreshToken).toBe("disc-refresh");
    });

    it("should throw when Discord returns an error", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: "invalid_grant" }, 400)
      );

      await expect(
        discord.exchangeCodeForTokens("bad-code", baseConfig)
      ).rejects.toThrow("Discord token exchange failed");
    });
  });
});

describe("OAuth Flow - Cross-Provider Consistency", () => {
  // Twitter excluded: uses OAuth 1.0a — getOAuthUrl is async and requires live credentials.
  const providers = [
    { name: "LinkedIn", instance: new LinkedInProvider() },
    { name: "Facebook", instance: new FacebookProvider() },
    { name: "Discord", instance: new DiscordProvider() },
  ] as const;

  for (const { name, instance } of providers) {
    it(`${name}: getOAuthUrl should return a string starting with https://`, () => {
      const url = instance.getOAuthUrl(baseConfig, "state");
      expect(url).toMatch(/^https:\/\//);
    });

    it(`${name}: getOAuthUrl should include the state parameter`, () => {
      const url = instance.getOAuthUrl(baseConfig, "unique-state-value");
      expect(url).toContain("unique-state-value");
    });

    it(`${name}: getOAuthUrl should include the callback URL`, () => {
      const url = instance.getOAuthUrl(baseConfig, "s");
      expect(url).toContain(encodeURIComponent("https://app.example.com/callback"));
    });
  }
});
