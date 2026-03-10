export interface SocialPostPayload {
  content: string;
  mediaUrls?: string[];
  metadata?: Record<string, unknown>;
}

export interface SocialPostResult {
  platformPostId: string;
  url: string;
  metadata?: Record<string, unknown>;
}

export interface SocialAnalytics {
  impressions: number;
  clicks: number;
  likes: number;
  shares: number;
  comments: number;
  reach: number;
  engagementRate: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: string[];
}

export interface SocialProfile {
  id: string;
  name: string;
  username?: string;
  avatar?: string;
}

export interface PlatformConstraints {
  maxContentLength: number;
  supportedMediaTypes: string[];
  maxMediaCount: number;
  maxMediaSize?: number; // bytes
  supportsThreads?: boolean;
  supportsScheduling?: boolean;
}
