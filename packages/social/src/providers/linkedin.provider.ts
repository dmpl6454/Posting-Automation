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

const API_VERSION = "202401";

function restHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

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
    const orgId = payload.metadata?.orgId as string | undefined;
    let author: string;

    if (orgId) {
      author = `urn:li:organization:${orgId}`;
    } else {
      const profile = await this.getProfile(tokens);
      author = `urn:li:person:${profile.id}`;
    }

    // Build the post body (Community Management API format)
    const body: Record<string, unknown> = {
      author,
      commentary: payload.content,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
    };

    // Upload and attach media if provided
    if (payload.mediaUrls?.length) {
      const firstUrl = payload.mediaUrls[0]!;
      const isVideo =
        /\.(mp4|mov|avi|mkv|webm)$/i.test(firstUrl) ||
        (payload.mediaTypes?.[0] ?? "").startsWith("video/");

      if (isVideo) {
        const videoUrn = await this.uploadVideo(tokens, author, firstUrl);
        body.content = { media: { id: videoUrn } };
      } else if (payload.mediaUrls.length === 1) {
        // Single image
        const imageUrn = await this.uploadImage(tokens, author, firstUrl);
        body.content = { media: { id: imageUrn } };
      } else {
        // Multiple images → multiImage
        const imageUrns: string[] = [];
        for (const url of payload.mediaUrls) {
          const urn = await this.uploadImage(tokens, author, url);
          imageUrns.push(urn);
        }
        body.content = {
          multiImage: {
            images: imageUrns.map((id) => ({ id })),
          },
        };
      }
    }

    const res = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: restHeaders(tokens.accessToken),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LinkedIn post failed: ${errText}`);
    }

    // Post ID is in the x-restli-id header
    const postId = res.headers.get("x-restli-id") ?? "";
    return {
      platformPostId: postId,
      url: `https://www.linkedin.com/feed/update/${postId}`,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const res = await fetch(
      `https://api.linkedin.com/rest/posts/${encodeURIComponent(platformPostId)}`,
      {
        method: "DELETE",
        headers: restHeaders(tokens.accessToken),
      }
    );
    if (!res.ok) {
      const data = await res.text();
      throw new Error(`LinkedIn delete failed: ${data}`);
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
        `https://api.linkedin.com/rest/socialActions/${encodedId}`,
        { headers: restHeaders(tokens.accessToken) }
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
   * Uses Community Management API endpoints.
   */
  async getPages(tokens: OAuthTokens): Promise<Array<{ id: string; name: string; avatar?: string; accessToken: string }>> {
    const pages: Array<{ id: string; name: string; avatar?: string; accessToken: string }> = [];

    const res = await fetch(
      "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR",
      { headers: restHeaders(tokens.accessToken) }
    );

    if (!res.ok) {
      console.warn(`[LinkedIn] Failed to fetch organizations: ${res.status} ${await res.text()}`);
      return pages;
    }

    const data: any = await res.json();
    const elements = data.elements ?? [];

    for (const el of elements) {
      // el.organization is like "urn:li:organization:12345"
      const orgUrn = el.organization ?? "";
      const orgId = orgUrn.split(":").pop() ?? "";
      if (!orgId) continue;

      // Fetch org details
      const orgRes = await fetch(
        `https://api.linkedin.com/rest/organizations/${orgId}`,
        { headers: restHeaders(tokens.accessToken) }
      );

      let name = `Organization ${orgId}`;
      let avatar: string | undefined;

      if (orgRes.ok) {
        const orgData: any = await orgRes.json();
        name = orgData.localizedName ?? name;
        avatar = orgData.logoV2?.["original~"]?.elements?.[0]?.identifiers?.[0]?.identifier;
      }

      pages.push({
        id: orgId,
        name,
        avatar,
        accessToken: tokens.accessToken,
      });
    }

    return pages;
  }

  // ── Media upload helpers (Community Management API) ──

  private async uploadImage(
    tokens: OAuthTokens,
    owner: string,
    mediaUrl: string
  ): Promise<string> {
    // 1. Initialize upload
    const initRes = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST",
      headers: restHeaders(tokens.accessToken),
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
    });

    const initData: any = await initRes.json();
    if (!initRes.ok) throw new Error(`LinkedIn image init failed: ${JSON.stringify(initData)}`);

    const uploadUrl = initData.value.uploadUrl;
    const imageUrn = initData.value.image;

    // 2. Download the image
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new Error(`Failed to download media: ${mediaUrl}`);
    const buffer = await mediaRes.arrayBuffer();

    // 3. Upload binary
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(buffer),
    });

    if (!uploadRes.ok) {
      throw new Error(`LinkedIn image upload failed: ${uploadRes.status}`);
    }

    return imageUrn;
  }

  private async uploadVideo(
    tokens: OAuthTokens,
    owner: string,
    mediaUrl: string
  ): Promise<string> {
    // 1. Download video first to get size
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new Error(`Failed to download video: ${mediaUrl}`);
    const buffer = await mediaRes.arrayBuffer();

    // 2. Initialize upload
    const initRes = await fetch("https://api.linkedin.com/rest/videos?action=initializeUpload", {
      method: "POST",
      headers: restHeaders(tokens.accessToken),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner,
          fileSizeBytes: buffer.byteLength,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    });

    const initData: any = await initRes.json();
    if (!initRes.ok) throw new Error(`LinkedIn video init failed: ${JSON.stringify(initData)}`);

    const videoUrn = initData.value.video;
    const uploadInstructions = initData.value.uploadInstructions ?? [];

    // 3. Upload each chunk
    for (const instruction of uploadInstructions) {
      const start = instruction.firstByte ?? 0;
      const end = (instruction.lastByte ?? buffer.byteLength - 1) + 1;
      const chunk = buffer.slice(start, end);

      const uploadRes = await fetch(instruction.uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(chunk),
      });

      if (!uploadRes.ok) {
        throw new Error(`LinkedIn video chunk upload failed: ${uploadRes.status}`);
      }
    }

    // 4. Finalize upload
    const finalizeRes = await fetch("https://api.linkedin.com/rest/videos?action=finalizeUpload", {
      method: "POST",
      headers: restHeaders(tokens.accessToken),
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken: "",
          uploadedPartIds: uploadInstructions.map((_: any, i: number) => String(i)),
        },
      }),
    });

    if (!finalizeRes.ok) {
      console.warn(`[LinkedIn] Video finalize response: ${finalizeRes.status}`);
    }

    return videoUrn;
  }
}
