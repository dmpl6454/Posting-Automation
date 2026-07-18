import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import type {
  SocialPostPayload,
  SocialPostResult,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "../abstract/social.types";
import { fetchT } from "../utils/fetch-timeout";

/**
 * Snapchat provider — CONNECT-ONLY as of 2026-07-18.
 *
 * Scope of this file: OAuth connect + callback + token refresh + profile read,
 * modeled on youtube.provider.ts (Snapchat is OAuth 2.0 authorization_code +
 * refresh tokens, same shape as Google). This is enough to add "Connect
 * Snapchat" to the Channels page and store a channel.
 *
 * Posting (Spotlight/Story/Saved Story) and insights are DELIBERATELY NOT
 * implemented yet — publishPost/deletePost throw a clear "not yet available"
 * and getPostAnalytics inherits the base-class `null`. They are gated behind:
 *   (a) Snap allowlisting our OAuth Client ID for the Public Profile API
 *       (currently pending — Snap support Case #05443628; every call 403s with
 *       AUTHORIZATION_PERMISSION_DENIED until then), and
 *   (b) the media-upload pipeline (Create Media -> multipart upload of a
 *       client-side AES-encrypted file -> POST spotlights/stories), which is a
 *       separate, larger piece of work.
 * See docs/SNAPCHAT-BUILD-PLAN.md for the full posting/insights spec.
 *
 * All endpoints/behaviors below are verified against developers.snap.com
 * (Login Kit Overview + Public Profile API, 2026-07-18):
 *   - Authorize: https://accounts.snapchat.com/accounts/oauth2/auth
 *   - Token:     https://accounts.snapchat.com/accounts/oauth2/token
 *   - Grant: authorization_code | refresh_token, x-www-form-urlencoded body.
 *   - Access token TTL 1h; the refresh response ROTATES the refresh_token.
 *   - Scope `snapchat-profile-api` (space-delimited); server-side (confidential)
 *     client uses client_secret, so PKCE is not required for us.
 *   - Profile: GET /v1/public_profiles/my_profile (needs snapchat-profile-api).
 */
export class SnapchatProvider extends SocialProvider {
  readonly platform: SocialPlatform = "SNAPCHAT";
  readonly displayName = "Snapchat";
  readonly constraints: PlatformConstraints = {
    // Spotlight/Story description cap is 160 chars (Public Profile API). Kept as
    // the content limit even though posting isn't wired yet, so validateContent
    // is honest the moment posting lands.
    maxContentLength: 160,
    supportedMediaTypes: ["video/mp4", "image/jpeg", "image/png"],
    maxMediaCount: 1,
    maxMediaSize: 1024 * 1024 * 1024, // 1GB multipart ceiling
    supportsScheduling: false,
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: "code",
      // Snapchat scopes are space-delimited (like Google), so join(" ") — do NOT
      // comma-join (that's Meta-specific).
      scope: config.scopes.join(" "),
      state,
    });
    return `https://accounts.snapchat.com/accounts/oauth2/auth?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetchT("https://accounts.snapchat.com/accounts/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        grant_type: "authorization_code",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Snapchat token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" "),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetchT("https://accounts.snapchat.com/accounts/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Snapchat token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      // Snapchat ROTATES the refresh token on refresh — persist the NEW one,
      // falling back to the incoming one only if the response omits it. Do NOT
      // copy YouTube's reuse-the-old-token behavior, or the channel dies on the
      // next refresh.
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" "),
    };
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    // Resolve the Public Profile the connected user administers. Requires the
    // `snapchat-profile-api` scope AND our client ID to be allowlisted — until
    // allowlisting lands this returns 403 AUTHORIZATION_PERMISSION_DENIED, which
    // surfaces as a clean connect error (never an unguarded throw of raw text).
    const res = await fetchT(
      "https://businessapi.snapchat.com/v1/public_profiles/my_profile",
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Snapchat profile fetch failed: ${JSON.stringify(data)}`);

    const profile = data.public_profile;
    if (!profile?.id) throw new Error("Snapchat profile fetch failed: no public profile found");

    return {
      id: profile.id,
      name: profile.display_name ?? profile.snap_user_name ?? "Snapchat Profile",
      // snap_user_name has no leading "@"; strip defensively so the UI can
      // safely prepend its own "@" without doubling.
      username: profile.snap_user_name?.replace(/^@+/, "") ?? undefined,
      avatar: profile.logo_urls?.original_logo_url ?? undefined,
    };
  }

  async publishPost(_tokens: OAuthTokens, _payload: SocialPostPayload): Promise<SocialPostResult> {
    // Not yet implemented — posting requires (a) Snap Public Profile API
    // allowlist approval for our client ID (pending) and (b) the media-upload
    // pipeline (Create Media -> multipart upload of an AES-encrypted file ->
    // POST spotlights/stories). See docs/SNAPCHAT-BUILD-PLAN.md.
    throw new Error(
      "Snapchat publishing is not available yet. Connecting your Snapchat account works, " +
        "but posting is pending Snap's Public Profile API approval."
    );
  }

  async deletePost(_tokens: OAuthTokens, _platformPostId: string): Promise<void> {
    throw new Error("Snapchat does not support programmatic post deletion.");
  }
}
