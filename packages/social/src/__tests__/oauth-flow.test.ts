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

describe("OAuth Flow - Twitter", () => {
  const twitter = new TwitterProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getOAuthUrl()", () => {
    it("should return a URL pointing to twitter.com OAuth2 authorize", () => {
      const url = twitter.getOAuthUrl(baseConfig, "state123");
      expect(url).toContain("https://twitter.com/i/oauth2/authorize");
    });

    it("should include client_id in the URL", () => {
      const url = twitter.getOAuthUrl(baseConfig, "state123");
      expect(url).toContain("client_id=test-client-id");
    });

    it("should include redirect_uri in the URL", () => {
      const url = twitter.getOAuthUrl(baseConfig, "state123");
      expect(url).toContain(
        `redirect_uri=${encodeURIComponent("https://app.example.com/callback")}`
      );
    });

    it("should include the state parameter", () => {
      const url = twitter.getOAuthUrl(baseConfig, "my-unique-state");
      expect(url).toContain("state=my-unique-state");
    });

    it("should include scopes joined by space", () => {
      const url = twitter.getOAuthUrl(baseConfig, "s");
      expect(url).toContain("scope=read+write");
    });

    it("should include PKCE code_challenge parameters", () => {
      const url = twitter.getOAuthUrl(baseConfig, "s");
      expect(url).toContain("code_challenge");
      expect(url).toContain("code_challenge_method=S256");
    });
  });

  describe("exchangeCodeForTokens()", () => {
    it("should exchange an authorization code for tokens", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "tw-access-token",
          refresh_token: "tw-refresh-token",
          expires_in: 7200,
          scope: "read write",
        })
      );

      const tokens = await twitter.exchangeCodeForTokens("auth-code", baseConfig);

      expect(tokens.accessToken).toBe("tw-access-token");
      expect(tokens.refreshToken).toBe("tw-refresh-token");
      expect(tokens.expiresAt).toBeInstanceOf(Date);
      expect(tokens.scopes).toEqual(["read", "write"]);
    });

    it("should send Basic auth header with base64 encoded credentials", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ access_token: "t", expires_in: 3600 })
      );

      await twitter.exchangeCodeForTokens("code", baseConfig);

      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<
        string,
        string
      >;
      const expectedAuth = `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`;
      expect(headers.Authorization).toBe(expectedAuth);
    });

    it("should throw when the API returns an error", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: "invalid_grant" }, 400)
      );

      await expect(
        twitter.exchangeCodeForTokens("bad-code", baseConfig)
      ).rejects.toThrow("Twitter token exchange failed");
    });
  });

  describe("refreshAccessToken()", () => {
    it("should refresh the access token using the refresh token", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 7200,
        })
      );

      const tokens = await twitter.refreshAccessToken("old-refresh", baseConfig);

      expect(tokens.accessToken).toBe("new-access-token");
      expect(tokens.refreshToken).toBe("new-refresh-token");
    });

    it("should throw when refresh fails", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: "invalid_token" }, 401)
      );

      await expect(
        twitter.refreshAccessToken("expired-refresh", baseConfig)
      ).rejects.toThrow("Twitter token refresh failed");
    });
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
  const providers = [
    { name: "Twitter", instance: new TwitterProvider() },
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
