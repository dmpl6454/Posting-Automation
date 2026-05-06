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
