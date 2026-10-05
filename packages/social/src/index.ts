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
// Multi-Meta-app support. A Meta token is bound to the app that minted it, so
// `Channel.metaAppId` (NULL = the legacy FACEBOOK_/INSTAGRAM_ pair) selects the
// credentials for every downstream call. See meta-app-registry.ts.
export {
  resolveMetaCredentials,
  legacyMetaCredentials,
  isMetaPlatform,
  resolvePlatformCredentials,
  listAllMetaApps,
  listExtraMetaApps,
  listMetaWebhookSecrets,
  hasMultipleMetaApps,
  isKnownMetaAppId,
  type MetaAppCredentials,
  type MetaPlatform,
} from "./utils/meta-app-registry";
export {
  verifyMetaWebhookSignature,
  type MetaWebhookVerification,
} from "./utils/meta-webhook-signature";
// FB app-usage health check — reads x-app-usage header from a lightweight
// call so a monitoring cron can alert before we hit the quota wall.
export { readFacebookAppHealth, type FbAppHealthReading } from "./utils/fb-app-health";
// FB Graph API deprecation-warning sniffer + in-memory cache. The provider
// records warnings from response headers; a worker cron drains + writes to
// ErrorLog on its own schedule (keeps @postautomation/social prisma-free).
export {
  drainFbDeprecationCache,
  fbDeprecationCacheSize,
  type FbDeprecationRecord,
} from "./utils/fb-deprecation-cache";
// Publish-outcome ambiguity. The publish worker MUST consult
// isAmbiguousPublishError before allowing any retry layer to re-run a publish —
// see the 2026-08-13 duplicate-post incident in ambiguous-publish.ts.
export {
  AmbiguousPublishError,
  isAmbiguousPublishError,
  isIndeterminatePublishError,
} from "./utils/ambiguous-publish";
// The opposite of ambiguous: refused before anything was created (2026-10-01).
export { PublishRefusedError, isPublishRefusedError, type PublishRefusedReason } from "./utils/publish-refused";
// SSRF-safe access to servers a USER named (Mastodon instance, self-hosted
// WordPress site, webhook endpoint). Never contact those with plain fetch() —
// see user-host-fetch.ts for why.
export { isPrivateAddress, checkHostIsPublic, type HostCheck } from "./utils/public-address";
export {
  userHostFetch,
  createPinnedLookup,
  UserHostError,
  isUserHostError,
  type UserHostErrorKind,
  type UserHostInit,
} from "./utils/user-host-fetch";
export {
  MASTODON_SERVICE,
  WORDPRESS_SERVICE,
  DISCORD_SERVICE,
  userHostFailure,
  userHostStatusFailure,
  unconfirmedCreate,
  retryableMediaFailure,
  summarizeRemoteError,
  type UserHostService,
  type UserHostPhase,
} from "./utils/user-host-publish";
// WordPress ARTICLE posts (2026-10-04): the metadata shape Compose's Article
// mode writes and the safe Markdown renderer the provider and preview share.
export {
  readWordPressArticle,
  imageFiguresHtml,
  WORDPRESS_ARTICLE_STATUSES,
  type WordPressArticleMeta,
  type WordPressArticleStatus,
  type WordPressSiteTaxonomy,
} from "./utils/wordpress-article";
export { markdownToHtml, markdownToExcerpt } from "./utils/markdown-lite";
export type { ExternalPostSummary, ExternalPostPage } from "./abstract/social.types";
// Instagram comment replies (2026-09-19) — see instagram-comments.ts for the
// current instagram_manage_comments permission status.
export {
  COMMENT_REPLY_MAX_LENGTH,
  // 🔴 The router MUST validate client-supplied comment ids with this before
  // they reach a Graph URL path — see the note on the constant.
  GRAPH_OBJECT_ID_RE,
  isValidGraphObjectId,
  type InstagramComment,
  type InstagramCommentPage,
  type InstagramOwnAccount,
} from "./utils/instagram-comments";
// Facebook Page comments (2026-09-23) — read needs pages_read_user_content,
// reply needs pages_manage_engagement. See facebook-comments.ts.
export { FB_COMMENT_MAX_LENGTH } from "./utils/facebook-comments";
export { commentCapabilities, COMMENT_READ_SCOPES, COMMENT_WRITE_SCOPES, COMMENT_LIKE_SCOPES } from "./utils/social-comments";
// Unanswered-comments queue (2026-10-05) — pure "still needs a reply" rule.
export { selectUnanswered, type UnansweredComment } from "./utils/unanswered-comments";
// Comment automation (2026-10-05) — auto-hide rule matcher.
export {
  matchCommentRule,
  normalizeBlockedWords,
  containsLink,
  MAX_BLOCKED_WORDS,
  MAX_BLOCKED_WORD_LENGTH,
  type CommentRules,
  type RuleMatch,
} from "./utils/comment-rules";
export { facebookAppUsagePeak } from "./providers/facebook.provider";
// Private replies + Messenger / Instagram Direct (2026-10-05) — see meta-messaging.ts.
export {
  messagingCapabilities,
  isValidConversationId,
  messageTextTooLong,
  messagingFailureOf,
  isMessageUnconfirmedText,
  privateReplyWindowOpen,
  messagingFailureMessage,
  MESSAGING_PAGE_LINK_MISSING_MESSAGE,
  MessagingError,
  MESSENGER_TEXT_MAX_CHARS,
  INSTAGRAM_DM_TEXT_MAX_BYTES,
  PRIVATE_REPLY_SCOPES,
  INBOX_SCOPES,
  type MessagingCapabilities,
  type MessagingPlatform,
  type SocialConversation,
  type SocialConversationPage,
  type SocialConversationThread,
  type SocialMessage,
  type MessageParticipant,
  type MessageAttachment,
} from "./utils/meta-messaging";
export { COMMENT_NOT_ON_POST_MESSAGE, COMMENT_LIKE_PERMISSION_MESSAGE, COMMENT_LIKE_REFUSED_MESSAGE } from "./utils/instagram-comments";
export type {
  CommentCapabilities,
  CommentModerationAction,
  CommentPlatform,
  SocialComment,
  SocialCommentAuthor,
  SocialCommentPage,
} from "./utils/social-comments";
