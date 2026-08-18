import type { SocialPlatform } from "@postautomation/db";
import type {
  SocialPostPayload,
  SocialPostResult,
  SocialAnalytics,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "./social.types";

export abstract class SocialProvider {
  abstract readonly platform: SocialPlatform;
  abstract readonly displayName: string;
  abstract readonly constraints: PlatformConstraints;

  // OAuth flow
  abstract getOAuthUrl(config: OAuthConfig, state: string): string | Promise<string>;
  abstract exchangeCodeForTokens(code: string, config: OAuthConfig, codeVerifier?: string): Promise<OAuthTokens>;
  abstract refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens>;

  // Posting
  abstract publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult>;
  abstract deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void>;

  /**
   * OPTIONAL reconciliation hook: "has a post with this payload already landed on
   * this account since `since`?"
   *
   * Publishing is NOT idempotent, so a retry can only be safe if we first ask the
   * platform whether the previous attempt actually landed. The publish worker
   * calls this before EVERY re-publish; a provider that does not implement it
   * keeps the old behaviour exactly, and its retries stay unguarded.
   *
   * Contract — the three outcomes must stay distinct:
   *   - a result  ⇒ the post exists; adopt it, do not publish again;
   *   - `null`    ⇒ the account was readable and has no such post; safe to retry;
   *   - THROW     ⇒ could not be determined; the caller must treat it as ambiguous
   *                 and must NOT publish again.
   *
   * ⚠️ Never collapse "cannot tell" into `null`. That single conflation is what
   * produced the 2026-08-13 duplicate-post incident.
   */
  findExistingPost?(
    tokens: OAuthTokens,
    payload: SocialPostPayload,
    since: Date
  ): Promise<SocialPostResult | null>;

  // Profile info
  abstract getProfile(tokens: OAuthTokens): Promise<SocialProfile>;

  // Analytics (optional — override in providers that support it)
  async getPostAnalytics(
    _tokens: OAuthTokens,
    _platformPostId: string
  ): Promise<SocialAnalytics | null> {
    return null;
  }

  // Content validation
  validateContent(payload: SocialPostPayload): string[] {
    const errors: string[] = [];
    if (payload.content.length > this.constraints.maxContentLength) {
      errors.push(
        `Content exceeds ${this.constraints.maxContentLength} character limit for ${this.displayName}`
      );
    }
    if (
      payload.mediaUrls &&
      payload.mediaUrls.length > this.constraints.maxMediaCount
    ) {
      errors.push(
        `Too many media attachments. ${this.displayName} allows max ${this.constraints.maxMediaCount}.`
      );
    }
    return errors;
  }
}
