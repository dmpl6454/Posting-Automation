import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import type {
  SocialPostPayload,
  SocialPostResult,
  SocialAnalytics,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "../abstract/social.types";

export class LinkedInProvider extends SocialProvider {
  readonly platform: SocialPlatform = "LINKEDIN";
  readonly displayName = "LinkedIn";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 3000,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 20,
    maxMediaSize: 10 * 1024 * 1024,
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(" "),
      state,
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUrl,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`LinkedIn token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(","),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`LinkedIn token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    // Use org URN for pages, person URN for personal profiles
    const orgId = payload.metadata?.orgId as string | undefined;
    let author: string;

    if (orgId) {
      author = `urn:li:organization:${orgId}`;
    } else {
      const profile = await this.getProfile(tokens);
      author = `urn:li:person:${profile.id}`;
    }

    // Build media array if URLs provided
    let shareMediaCategory = "NONE";
    const media: any[] = [];

    if (payload.mediaUrls?.length) {
      for (const url of payload.mediaUrls) {
        const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(url) ||
          (payload.mediaTypes?.[0] ?? "").startsWith("video/");

        if (isVideo) {
          shareMediaCategory = "VIDEO";
          // For video, register upload then use asset
          const asset = await this.registerUpload(tokens, author, "VIDEO");
          await this.uploadMedia(tokens, asset.uploadUrl, url);
          media.push({
            status: "READY",
            media: asset.asset,
            title: { text: "Video" },
          });
        } else {
          shareMediaCategory = "IMAGE";
          const asset = await this.registerUpload(tokens, author, "IMAGE");
          await this.uploadMedia(tokens, asset.uploadUrl, url);
          media.push({
            status: "READY",
            media: asset.asset,
            title: { text: "Image" },
          });
        }
      }
    }

    const shareContent: any = {
      shareCommentary: { text: payload.content },
      shareMediaCategory,
    };
    if (media.length > 0) {
      shareContent.media = media;
    }

    const body: Record<string, unknown> = {
      author,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": shareContent,
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    };

    const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`LinkedIn post failed: ${JSON.stringify(data)}`);

    const postId = data.id;
    return {
      platformPostId: postId,
      url: `https://www.linkedin.com/feed/update/${postId}`,
      metadata: data,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const res = await fetch(
      `https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(platformPostId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );
    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`LinkedIn delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(`LinkedIn profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.sub,
      name: data.name,
      avatar: data.picture,
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    try {
      const encodedId = encodeURIComponent(platformPostId);
      const res = await fetch(
        `https://api.linkedin.com/v2/socialActions/${encodedId}`,
        { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
      );
      if (!res.ok) {
        console.warn(`[LinkedIn] Analytics failed ${res.status}: ${await res.text()}`);
        return null;
      }
      const data: any = await res.json();
      const likes = data.likesSummary?.totalLikes ?? 0;
      const comments = data.commentsSummary?.totalFirstLevelComments ?? 0;
      return {
        impressions: 0,
        clicks: 0,
        likes,
        shares: 0,
        comments,
        reach: 0,
        engagementRate: 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch LinkedIn Pages (organizations) the user administers.
   */
  async getPages(tokens: OAuthTokens): Promise<Array<{ id: string; name: string; avatar?: string; accessToken: string }>> {
    const pages: Array<{ id: string; name: string; avatar?: string; accessToken: string }> = [];

    // Get organizations where user is admin
    const aclRes = await fetch(
      "https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,localizedName,logoV2(original~:playableStreams))))",
      {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );

    if (!aclRes.ok) {
      console.warn(`[LinkedIn] Failed to fetch organizations: ${aclRes.status} ${await aclRes.text()}`);
      return pages;
    }

    const aclData: any = await aclRes.json();
    const elements = aclData.elements ?? [];

    for (const el of elements) {
      const org = el["organization~"];
      if (!org) continue;

      const logoUrl = org.logoV2?.["original~"]?.elements?.[0]?.identifiers?.[0]?.identifier;

      pages.push({
        id: String(org.id),
        name: org.localizedName ?? `Organization ${org.id}`,
        avatar: logoUrl,
        accessToken: tokens.accessToken, // Same token works for org posts
      });
    }

    return pages;
  }

  // ── Media upload helpers ──

  private async registerUpload(
    tokens: OAuthTokens,
    owner: string,
    mediaType: "IMAGE" | "VIDEO"
  ): Promise<{ uploadUrl: string; asset: string }> {
    const recipe = mediaType === "VIDEO"
      ? "urn:li:digitalmediaRecipe:feedshare-video"
      : "urn:li:digitalmediaRecipe:feedshare-image";

    const body = {
      registerUploadRequest: {
        recipes: [recipe],
        owner,
        serviceRelationships: [
          { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
        ],
      },
    };

    const res = await fetch("https://api.linkedin.com/v2/assets?action=registerUpload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`LinkedIn register upload failed: ${JSON.stringify(data)}`);

    const uploadUrl = data.value.uploadMechanism[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ].uploadUrl;
    const asset = data.value.asset;

    return { uploadUrl, asset };
  }

  private async uploadMedia(tokens: OAuthTokens, uploadUrl: string, mediaUrl: string): Promise<void> {
    // Download media
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new Error(`Failed to download media: ${mediaUrl}`);
    const buffer = await mediaRes.arrayBuffer();

    // Upload to LinkedIn
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(buffer),
    });

    if (!uploadRes.ok) {
      throw new Error(`LinkedIn media upload failed: ${uploadRes.status}`);
    }
  }
}
