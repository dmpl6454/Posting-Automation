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
import { userHostFetch, type UserHostInit } from "../utils/user-host-fetch";
import { markdownToHtml } from "../utils/markdown-lite";
import { readWordPressArticle, imageFiguresHtml, type WordPressArticleMeta } from "../utils/wordpress-article";
import {
  WORDPRESS_SERVICE as SVC,
  userHostFailure,
  userHostStatusFailure,
  unconfirmedCreate,
  retryableMediaFailure,
  type UserHostPhase,
} from "../utils/user-host-publish";

/**
 * ⚠️ A SELF-HOSTED site is a server the USER named at connect time
 * (Channel.metadata.siteUrl). Every request to it goes through `siteCall()`,
 * which uses userHostFetch: DNS pinned to vetted public addresses, no
 * redirects, a deadline, and fixed-text errors (see ../utils/user-host-fetch.ts).
 * Plain fetch() here was an SSRF (2026-10-01). Locked by
 * __tests__/wordpress-user-host.test.ts. The WordPress.com OAuth path talks to
 * public-api.wordpress.com, a fixed host, and keeps plain fetch().
 */
const CREATE_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 20_000;

export class WordPressProvider extends SocialProvider {
  readonly platform: SocialPlatform = "WORDPRESS";
  readonly displayName = "WordPress";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 100000,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"],
    maxMediaCount: 50,
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: "code",
      state,
      blog: "", // let user choose their site during auth
    });
    return `https://public-api.wordpress.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://public-api.wordpress.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        code,
        grant_type: "authorization_code",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`WordPress token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      // WordPress.com tokens don't expire by default, no refresh token
      refreshToken: undefined,
      expiresAt: undefined,
      scopes: ["global"],
      metadata: {
        blog_id: data.blog_id,
        blog_url: data.blog_url,
      },
    };
  }

  async refreshAccessToken(_refreshToken: string, _config: OAuthConfig): Promise<OAuthTokens> {
    // WordPress.com OAuth tokens don't expire — re-auth is needed if revoked
    throw new Error("WordPress.com tokens do not expire. Re-authorize if the token is revoked.");
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    // Self-hosted path — connected via Application Password (kind === "self-hosted").
    // accessToken is base64(username:appPassword), used as `Authorization: Basic <token>`.
    const isSelfHosted = (tokens as any)?.metadata?.kind === "self-hosted";
    if (isSelfHosted) {
      return this.publishSelfHosted(tokens, payload);
    }

    // blog_id comes from channel metadata (stored during OAuth callback)
    const siteId = (payload.metadata as any)?.blog_id || tokens.metadata?.blog_id;
    if (!siteId) throw new Error("WordPress blog_id not found in channel metadata. Re-connect the channel.");

    // Upload media first if present
    const mediaIds: number[] = [];
    let featuredImageId: number | undefined;

    if (payload.mediaUrls?.length) {
      for (let i = 0; i < payload.mediaUrls.length; i++) {
        const url = payload.mediaUrls[i]!;
        const mediaRes = await this.uploadMediaFromUrl(tokens.accessToken, siteId, url);
        mediaIds.push(mediaRes.ID);
        if (i === 0) featuredImageId = mediaRes.ID;
      }
    }

    const title = (payload.metadata?.title as string) || (payload.content.split("\n")[0] ?? "").slice(0, 200);
    const status = (payload.metadata?.publishStatus as string) || "publish";
    const categories = (payload.metadata?.categories as string[]) || [];
    const tags = (payload.metadata?.tags as string[]) || [];
    const format = (payload.metadata?.format as string) || "standard";

    const body: Record<string, unknown> = {
      title,
      content: payload.content,
      status,
      format,
    };

    if (categories.length) body.categories_by_name = categories;
    if (tags.length) body.tags_by_name = tags;
    if (featuredImageId) body.featured_image = featuredImageId;
    if (mediaIds.length > 0) body.media_ids = mediaIds;

    const res = await fetch(`https://public-api.wordpress.com/rest/v1.2/sites/${siteId}/posts/new`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`WordPress post failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: String(data.ID),
      url: data.URL || data.short_URL,
      metadata: {
        id: data.ID,
        slug: data.slug,
        status: data.status,
        site_ID: data.site_ID,
      },
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string, metadata?: Record<string, unknown>): Promise<void> {
    const isSelfHosted = (tokens as any)?.metadata?.kind === "self-hosted";
    if (isSelfHosted) {
      const siteUrl = (tokens as any)?.metadata?.siteUrl as string;
      await this.siteCall(
        `${siteUrl}/wp-json/wp/v2/posts/${encodeURIComponent(platformPostId)}?force=true`,
        { method: "DELETE", headers: { Authorization: `Basic ${tokens.accessToken}` }, timeoutMs: READ_TIMEOUT_MS },
        "read",
      );
      return;
    }

    const siteId = (metadata as any)?.blog_id || tokens.metadata?.blog_id;
    if (!siteId) throw new Error("WordPress blog_id not found in channel metadata.");

    const res = await fetch(
      `https://public-api.wordpress.com/rest/v1.2/sites/${siteId}/posts/${platformPostId}/delete`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`WordPress delete failed: ${JSON.stringify(data)}`);
    }
  }

  /**
   * Self-hosted publish path — uses the WP REST API at /wp-json/wp/v2 with
   * Basic auth (an Application Password). Media is uploaded to /media first,
   * then referenced by the post via `featured_media`.
   */
  private async publishSelfHosted(
    tokens: OAuthTokens,
    payload: SocialPostPayload
  ): Promise<SocialPostResult> {
    const siteUrl = (tokens as any)?.metadata?.siteUrl as string;
    if (!siteUrl) throw new Error("WordPress siteUrl missing from channel metadata. Re-connect the channel.");

    const auth = `Basic ${tokens.accessToken}`;

    // Article mode (2026-10-04): Compose wrote `metadata.wordpressArticle`.
    // Absent ⇒ the legacy caption path below, byte-for-byte (test-locked).
    const article = readWordPressArticle(payload.metadata);
    if (article) return this.publishSelfHostedArticle(siteUrl, auth, payload, article);

    let featuredImageId: number | undefined;
    if (payload.mediaUrls?.length) {
      const first = payload.mediaUrls[0]!;
      featuredImageId = (await this.uploadSelfHostedMedia(siteUrl, auth, first)).id;
    }

    const title = (payload.metadata?.title as string) || (payload.content.split("\n")[0] ?? "").slice(0, 200);
    const status = (payload.metadata?.publishStatus as string) || "publish";
    const categories = (payload.metadata?.categories as number[]) || [];
    const tags = (payload.metadata?.tags as number[]) || [];

    const body: Record<string, unknown> = {
      title,
      content: payload.content,
      status,
    };
    if (categories.length) body.categories = categories;
    if (tags.length) body.tags = tags;
    if (featuredImageId) body.featured_media = featuredImageId;

    const res = await this.siteCall(
      `${siteUrl}/wp-json/wp/v2/posts`,
      {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: CREATE_TIMEOUT_MS,
      },
      "create",
    );
    const data: any = await this.readJson(res);
    // A 2xx means the post was created; without an id we cannot record it, and
    // retrying would create a second one.
    if (data?.id == null) throw unconfirmedCreate(SVC, "the site's reply could not be read");

    return {
      platformPostId: String(data.id),
      url: data.link,
      metadata: { id: data.id, slug: data.slug, status: data.status, siteUrl },
    };
  }

  /**
   * Article publish (self-hosted). Title/excerpt/status come from Compose's
   * Article mode; the body is Markdown rendered by markdown-lite (input is
   * escaped text — never raw HTML, see that file). EVERY image is uploaded to
   * the site's media library: the first becomes the featured image, the rest
   * are appended to the body as figures. Term ids are looked up by this site's
   * URL (ids are per install); tag NAMES are created or reused first.
   *
   * Order is load-bearing: media and tags are written BEFORE the post, so a
   * failure there is pre-create and plainly retryable; only the final POST can
   * leave an unknown outcome, and it goes through the same `create` phase
   * mapping as the legacy path (unconfirmed ⇒ "Needs check", never a retry).
   */
  private async publishSelfHostedArticle(
    siteUrl: string,
    auth: string,
    payload: SocialPostPayload,
    article: WordPressArticleMeta
  ): Promise<SocialPostResult> {
    const urls = payload.mediaUrls ?? [];
    const types = payload.mediaTypes ?? [];
    const isImage = (i: number) => {
      const t = types[i];
      if (t) return t.startsWith("image/");
      return /\.(jpe?g|png|gif|webp)(\?|$)/i.test(urls[i] ?? "");
    };

    let featuredImageId: number | undefined;
    const bodyImages: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      if (!isImage(i)) {
        console.warn(`[WordPress] article: skipping non-image attachment #${i + 1} (only images are placed in an article)`);
        continue;
      }
      const uploaded = await this.uploadSelfHostedMedia(siteUrl, auth, urls[i]!);
      if (featuredImageId === undefined) featuredImageId = uploaded.id;
      else if (uploaded.sourceUrl) bodyImages.push(uploaded.sourceUrl);
    }

    const tax = article.taxonomyBySite[siteUrl] ?? article.taxonomyBySite[siteUrl.toLowerCase()];
    const tagIds = new Set<number>(tax?.tagIds ?? []);
    for (const name of article.newTags) {
      const id = await this.ensureSelfHostedTag(siteUrl, auth, name);
      if (id) tagIds.add(id);
    }

    const figures = imageFiguresHtml(bodyImages);
    const html = markdownToHtml(payload.content);
    const body: Record<string, unknown> = {
      title: article.title,
      content: figures ? `${html}\n${figures}` : html,
      status: article.status,
    };
    if (article.excerpt) body.excerpt = article.excerpt;
    if (tax?.categoryIds.length) body.categories = tax.categoryIds;
    if (tagIds.size) body.tags = [...tagIds];
    if (featuredImageId) body.featured_media = featuredImageId;

    const res = await this.siteCall(
      `${siteUrl}/wp-json/wp/v2/posts`,
      {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: CREATE_TIMEOUT_MS,
      },
      "create",
    );
    const data: any = await this.readJson(res);
    if (data?.id == null) throw unconfirmedCreate(SVC, "the site's reply could not be read");

    return {
      platformPostId: String(data.id),
      url: data.link,
      metadata: { id: data.id, slug: data.slug, status: data.status, siteUrl, article: true },
    };
  }

  /**
   * Create a tag by name, or reuse the existing one (WordPress answers
   * 400 `term_exists` with the existing id). Best-effort: a tag that cannot be
   * resolved is dropped from the post, never fails the publish.
   */
  private async ensureSelfHostedTag(siteUrl: string, auth: string, name: string): Promise<number | null> {
    try {
      const res = await userHostFetch(`${siteUrl}/wp-json/wp/v2/tags`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        timeoutMs: READ_TIMEOUT_MS,
      });
      const data: any = await this.readJson(res);
      if (res.ok && typeof data?.id === "number") return data.id;
      if (res.status === 400 && data?.code === "term_exists") {
        const existing = data?.data?.term_id;
        return typeof existing === "number" ? existing : null;
      }
      console.warn(`[WordPress] article: could not create tag (HTTP ${res.status}) — publishing without it`);
      return null;
    } catch (err) {
      console.warn(`[WordPress] article: tag request failed — publishing without it: ${(err as Error)?.message}`);
      return null;
    }
  }

  private async uploadSelfHostedMedia(
    siteUrl: string,
    auth: string,
    mediaUrl: string
  ): Promise<{ id: number; sourceUrl?: string }> {
    // The post's own media file, from OUR storage — not a user-named host.
    let buffer: Buffer;
    let mediaType: string;
    try {
      const mediaRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
      if (!mediaRes.ok) throw new Error(`storage answered HTTP ${mediaRes.status}`);
      buffer = Buffer.from(await mediaRes.arrayBuffer());
      mediaType = mediaRes.headers.get("content-type") || "image/jpeg";
    } catch (err) {
      console.warn(`[WordPress] could not read media for upload: ${(err as Error)?.message}`);
      // No status code in the message: the worker's classifier reads "403" as a permission error.
      throw retryableMediaFailure(SVC, "the attached file could not be read from storage", err);
    }
    // Header-safe: a quote or line break in the stored name must not reach the header.
    const rawName = mediaUrl.split("/").pop()?.split("?")[0] || "";
    const filename =
      rawName.replace(/[^\w.-]/g, "_") || `upload.${(mediaType.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "")}`;

    const res = await this.siteCall(
      `${siteUrl}/wp-json/wp/v2/media`,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": mediaType,
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
        body: buffer,
        timeoutMs: MEDIA_TIMEOUT_MS,
      },
      "media",
    );
    const data: any = await this.readJson(res);
    if (data?.id == null) throw retryableMediaFailure(SVC, "the reply could not be read");
    return { id: data.id as number, sourceUrl: typeof data.source_url === "string" ? data.source_url : undefined };
  }

  /** The one way to talk to a self-hosted site. Throws the mapped error on failure or non-2xx. */
  private async siteCall(url: string, init: UserHostInit, phase: UserHostPhase): Promise<Response> {
    let res: Response;
    try {
      res = await userHostFetch(url, init);
    } catch (err) {
      throw userHostFailure(err, SVC, phase);
    }
    if (!res.ok) throw await userHostStatusFailure(res, SVC, phase);
    return res;
  }

  private async readJson(res: Response): Promise<any> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    // Get user info
    const userRes = await fetch("https://public-api.wordpress.com/rest/v1.1/me", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const userData: any = await userRes.json();
    if (!userRes.ok) throw new Error(`WordPress profile fetch failed: ${JSON.stringify(userData)}`);

    // Try to get site info
    const siteId = tokens.metadata?.blog_id;
    let siteName = userData.display_name;
    let siteUrl = userData.primary_blog_url;
    let avatar = userData.avatar_URL;

    if (siteId) {
      try {
        const siteRes = await fetch(`https://public-api.wordpress.com/rest/v1.1/sites/${siteId}`, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        const siteData: any = await siteRes.json();
        if (siteRes.ok) {
          siteName = siteData.name || siteName;
          siteUrl = siteData.URL || siteUrl;
          avatar = siteData.icon?.img || avatar;
        }
      } catch {
        // Use user-level data as fallback
      }
    }

    return {
      id: String(userData.ID),
      name: siteName,
      username: siteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "") || userData.username,
      avatar,
    };
  }

  private async uploadMediaFromUrl(
    accessToken: string,
    siteId: string,
    mediaUrl: string
  ): Promise<{ ID: number; URL: string }> {
    const body = { media_urls: [mediaUrl] };

    const res = await fetch(`https://public-api.wordpress.com/rest/v1.2/sites/${siteId}/media/new`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`WordPress media upload failed: ${JSON.stringify(data)}`);

    const media = data.media?.[0];
    if (!media) throw new Error("WordPress media upload returned empty response");

    return { ID: media.ID, URL: media.URL };
  }
}
