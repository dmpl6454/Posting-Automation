export { SocialProvider } from "./abstract/social.abstract";
export { getSocialProvider, getSupportedPlatforms } from "./abstract/social.factory";
export type {
  SocialPostPayload,
  SocialPostResult,
  SocialAnalytics,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "./abstract/social.types";
export { generateState, generateCodeVerifier, generateCodeChallenge, encryptToken, decryptToken } from "./utils/oauth-helper";
export { validateMediaForPlatform } from "./utils/media-validator";
