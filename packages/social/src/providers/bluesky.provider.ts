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

const BLUESKY_SERVICE = "https://bsky.social";

export class BlueskyProvider extends SocialProvider {
  readonly platform: SocialPlatform = "BLUESKY";
  readonly displayName = "Bluesky";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 300,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif"],
    maxMediaCount: 4,
    maxMediaSize: 1 * 1024 * 1024,
  };

  private getServiceUrl(tokens?: OAuthTokens): string {
    const service = (tokens as any)?.metadata?.service as string | undefined;
    return service || BLUESKY_SERVICE;
  }

  /**
   * Bluesky uses app passwords instead of OAuth.
   * Returns the Bluesky settings page where users create app passwords.
   */
  getOAuthUrl(_config: OAuthConfig, _state: string): string {
    return "https://bsky.app/settings/app-passwords";
  }

  /**
   * Bluesky uses app password authentication via createSession.
   * The `code` param is repurposed as the app password.
   * The `config.clientId` is repurposed as the Bluesky identifier (handle or DID).
   */
  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const identifier = config.clientId;
    const appPassword = code;

    const res = await fetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier,
        password: appPassword,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Bluesky authentication failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.accessJwt,
      refreshToken: data.refreshJwt,
      scopes: ["atproto"],
    };
  }

  async refreshAccessToken(refreshToken: string, _config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshToken}`,
      },
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Bluesky token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.accessJwt,
      refreshToken: data.refreshJwt,
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const service = this.getServiceUrl(tokens);
    const did = await this.resolveDid(tokens, service);

    // Upload media (blobs) if present
    let images: Array<{ alt: string; image: { $type: string; ref: { $link: string }; mimeType: string; size: number } }> = [];
    if (payload.mediaUrls?.length) {
      images = await Promise.all(
        payload.mediaUrls.map((url, i) => this.uploadBlob(tokens, service, url, (payload.metadata?.altTexts as string[])?.[i] || ""))
      );
    }

    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: payload.content,
      createdAt: new Date().toISOString(),
    };

    // Attach images embed if any
    if (images.length > 0) {
      record.embed = {
        $type: "app.bsky.embed.images",
        images,
      };
    }

    // Parse facets (links and mentions) from text
    const facets = this.parseFacets(payload.content);
    if (facets.length > 0) {
      record.facets = facets;
    }

    const res = await fetch(`${service}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: did,
        collection: "app.bsky.feed.post",
        record,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Bluesky post failed: ${JSON.stringify(data)}`);

    // Extract rkey from the URI: at://did/collection/rkey
    const rkey = data.uri.split("/").pop();
    return {
      platformPostId: data.uri,
      url: `https://bsky.app/profile/${did}/post/${rkey}`,
      metadata: {
        uri: data.uri,
        cid: data.cid,
      },
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const service = this.getServiceUrl(tokens);
    const did = await this.resolveDid(tokens, service);

    // platformPostId is the AT URI: at://did/collection/rkey
    const rkey = platformPostId.split("/").pop();

    const res = await fetch(`${service}/xrpc/com.atproto.repo.deleteRecord`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: did,
        collection: "app.bsky.feed.post",
        rkey,
      }),
    });

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Bluesky delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const service = this.getServiceUrl(tokens);
    const did = await this.resolveDid(tokens, service);

    const res = await fetch(
      `${service}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Bluesky profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.did,
      name: data.displayName || data.handle,
      username: data.handle,
      avatar: data.avatar,
    };
  }

  /**
   * Resolve the DID for the authenticated user via getSession.
   */
  private async resolveDid(tokens: OAuthTokens, service: string): Promise<string> {
    const res = await fetch(`${service}/xrpc/com.atproto.server.getSession`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Bluesky session resolution failed: ${JSON.stringify(data)}`);
    return data.did;
  }

  /**
   * Upload a media blob to the Bluesky PDS.
   */
  private async uploadBlob(
    tokens: OAuthTokens,
    service: string,
    mediaUrl: string,
    alt: string
  ): Promise<{ alt: string; image: { $type: string; ref: { $link: string }; mimeType: string; size: number } }> {
    const mediaRes = await fetch(mediaUrl);
    const mediaBuffer = Buffer.from(await mediaRes.arrayBuffer());
    const mimeType = mediaRes.headers.get("content-type") || "image/jpeg";

    const res = await fetch(`${service}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": mimeType,
      },
      body: mediaBuffer,
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Bluesky blob upload failed: ${JSON.stringify(data)}`);

    return {
      alt,
      image: data.blob,
    };
  }

  /**
   * Parse URLs in the post text into Bluesky facets (rich text).
   */
  private parseFacets(text: string): Array<{
    index: { byteStart: number; byteEnd: number };
    features: Array<{ $type: string; uri: string }>;
  }> {
    const facets: Array<{
      index: { byteStart: number; byteEnd: number };
      features: Array<{ $type: string; uri: string }>;
    }> = [];

    const urlRegex = /https?:\/\/[^\s)]+/g;
    let match: RegExpExecArray | null;
    const encoder = new TextEncoder();

    while ((match = urlRegex.exec(text)) !== null) {
      const beforeBytes = encoder.encode(text.slice(0, match.index));
      const matchBytes = encoder.encode(match[0]);
      facets.push({
        index: {
          byteStart: beforeBytes.byteLength,
          byteEnd: beforeBytes.byteLength + matchBytes.byteLength,
        },
        features: [
          {
            $type: "app.bsky.richtext.facet#link",
            uri: match[0],
          },
        ],
      });
    }

    return facets;
  }
}
