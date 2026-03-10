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
  abstract getOAuthUrl(config: OAuthConfig, state: string): string;
  abstract exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens>;
  abstract refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens>;

  // Posting
  abstract publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult>;
  abstract deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void>;

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
