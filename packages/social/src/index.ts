export { SocialProvider } from "./abstract/social.abstract";
export { getSocialProvider, getSupportedPlatforms } from "./abstract/social.factory";
export { FacebookProvider } from "./providers/facebook.provider";
export { InstagramProvider } from "./providers/instagram.provider";
export { LinkedInProvider } from "./providers/linkedin.provider";
export type {
  SocialPostPayload,
  SocialPostResult,
  SocialAnalytics,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "./abstract/social.types";
export {
  generateState,
  generateCodeVerifier,
  generateCodeChallenge,
  signState,
  verifyState,
} from "./utils/oauth-helper";
export type { OAuthStatePayload } from "./utils/oauth-helper";
// Re-exported from @postautomation/db (the canonical location to avoid
// a circular dep between db and social).
export { encryptToken, decryptToken, isEncrypted } from "@postautomation/db";
export { validateMediaForPlatform } from "./utils/media-validator";
// Meta's 90-day DATA-ACCESS window — a separate clock from token expiry, and the
// real reason Meta insights die every ~3 months. See meta-data-access.ts.
export { fetchMetaTokenWindow, type MetaTokenWindow } from "./utils/meta-data-access";
export { isFacebookVideoLike } from "./utils/fb-video-like";
// FB app-usage health check — reads x-app-usage header from a lightweight
// call so a monitoring cron can alert before we hit the quota wall.
export { readFacebookAppHealth, type FbAppHealthReading } from "./utils/fb-app-health";
export type { ExternalPostSummary, ExternalPostPage } from "./abstract/social.types";
