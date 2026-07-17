import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock @postautomation/db (providers only use the SocialPlatform type)
vi.mock("@postautomation/db", () => ({}));

import { InstagramProvider } from "../providers/instagram.provider";
import type { OAuthTokens } from "../abstract/social.types";

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

const tokens: OAuthTokens = {
  accessToken: "ig-access",
  refreshToken: undefined,
  expiresAt: undefined,
};

/**
 * Regression coverage for the 2026-07-17 new-user Instagram connect fix.
 *
 * Root cause: the OAuth callback called getProfile() for EVERY platform before
 * the Instagram branch. IG getProfile() → getInstagramBusinessAccountId(), which
 * THROWS "No Instagram Business Account found…" for a user with no linked IG
 * Business account. That throw hit the outer catch and was mislabelled as the
 * generic `oauth_failed` toast, so the clean `ig_no_business_account` guard
 * (gated on getAllInstagramAccounts() returning []) was unreachable dead code.
 *
 * These tests lock the two provider behaviours the fix depends on:
 *  1. getProfile() THROWS with a message the callback's catch-remap regex
 *     (/No Instagram Business Account|Instagram Professional account/i) matches.
 *  2. getAllInstagramAccounts() RETURNS [] (does NOT throw) for the same account,
 *     so the callback's ig_no_business_account guard fires once getProfile is
 *     no longer front-loaded for Instagram.
 */
describe("Instagram connect — no IG Business account", () => {
  const instagram = new InstagramProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getProfile() throws a message the callback catch-remap recognises", async () => {
    // me/accounts returns Pages with NO instagram_business_account linked.
    mockFetch.mockResolvedValueOnce(
      mockResponse({ data: [{ id: "page-1", name: "My Page" }] })
    );

    const promise = instagram.getProfile(tokens);
    await expect(promise).rejects.toThrow(/No Instagram Business Account/i);
    // The callback remap regex must keep matching this exact wording.
    await expect(promise).rejects.toThrow(
      /No Instagram Business Account|Instagram Professional account/i
    );
  });

  it("getProfile() also throws when the user administers zero Pages", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [] }));
    await expect(instagram.getProfile(tokens)).rejects.toThrow(
      /No Instagram Business Account/i
    );
  });

  it("getAllInstagramAccounts() returns [] (does NOT throw) for the same account", async () => {
    // Same scenario: Pages exist but none has a linked IG Business account.
    mockFetch.mockResolvedValueOnce(
      mockResponse({ data: [{ id: "page-1", name: "My Page" }] })
    );

    const accounts = await instagram.getAllInstagramAccounts(tokens);
    expect(accounts).toEqual([]);
  });

  it("getAllInstagramAccounts() returns the linked IG accounts when present", async () => {
    // Page list with a linked IG business account…
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        data: [
          {
            id: "page-1",
            name: "My Page",
            instagram_business_account: { id: "ig-123" },
          },
        ],
      })
    );
    // …then the per-account profile fetch.
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        id: "ig-123",
        username: "mybrand",
        profile_picture_url: "https://example.com/a.jpg",
      })
    );

    const accounts = await instagram.getAllInstagramAccounts(tokens);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: "ig-123", username: "mybrand" });
  });
});
