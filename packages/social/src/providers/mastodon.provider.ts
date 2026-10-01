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
import {
  MASTODON_SERVICE as SVC,
  userHostFailure,
  userHostStatusFailure,
  unconfirmedCreate,
  retryableMediaFailure,
  type UserHostPhase,
} from "../utils/user-host-publish";

const DEFAULT_INSTANCE = "https://mastodon.social";

/**
 * ⚠️ The instance is a server the USER named at connect time
 * (Channel.metadata.instance). Every request to it goes through `call()`, which
 * uses userHostFetch: DNS pinned to vetted public addresses, no redirects, a
 * deadline, and fixed-text errors (see ../utils/user-host-fetch.ts). Plain
 * fetch() here was an SSRF: the name was re-resolved on every call and
 * redirects were followed (2026-10-01). Locked by
 * __tests__/mastodon-user-host.test.ts. The only plain fetch() left reads the
 * post's own media file from our storage.
 */
const CREATE_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 20_000;
// GET /api/v1/media/:id answers 206 while a 202-accepted upload is processing.
const MEDIA_POLL_INTERVAL_MS = 2_000;
const MEDIA_POLL_ATTEMPTS = 30;

export class MastodonProvider extends SocialProvider {
  readonly platform: SocialPlatform = "MASTODON";
  readonly displayName = "Mastodon";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 500,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 4,
    maxMediaSize: 16 * 1024 * 1024,
  };

  private getInstanceUrl(config?: OAuthConfig): string {
    const instance = (config as any)?.metadata?.instance as string | undefined;
    return instance || DEFAULT_INSTANCE;
  }

  private getInstanceFromToken(tokens: OAuthTokens): string {
    const instance = (tokens as any)?.metadata?.instance as string | undefined;
    return instance || DEFAULT_INSTANCE;
  }

  /** The one way to talk to the instance. Throws the mapped error on failure or non-2xx. */
  private async call(url: string, init: UserHostInit, phase: UserHostPhase): Promise<Response> {
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

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const instance = this.getInstanceUrl(config);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(" "),
      state,
    });
    return `${instance}/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const instance = this.getInstanceUrl(config);
    const res = await this.call(
      `${instance}/oauth/token`,
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.callbackUrl,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
        timeoutMs: READ_TIMEOUT_MS,
      },
      "read",
    );
    const data = await this.readJson(res);
    if (!data?.access_token) throw new Error("Mastodon sign-in did not complete (no credentials in the reply).");

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
      scopes: data.scope?.split(" "),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const instance = this.getInstanceUrl(config);
    const res = await this.call(
      `${instance}/oauth/token`,
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
        timeoutMs: READ_TIMEOUT_MS,
      },
      "read",
    );
    const data = await this.readJson(res);
    if (!data?.access_token) throw new Error("Mastodon sign-in did not complete (no credentials in the reply).");

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const instance = this.getInstanceFromToken(tokens);

    // Media first. A failure here leaves at most an unattached upload, never a
    // post, so it is retryable.
    let mediaIds: string[] = [];
    if (payload.mediaUrls?.length) {
      mediaIds = await Promise.all(
        payload.mediaUrls.map((url, i) => this.uploadMedia(tokens, instance, url, payload.mediaTypes?.[i]))
      );
    }

    const body: Record<string, unknown> = {
      status: payload.content,
    };
    if (mediaIds.length > 0) {
      body.media_ids = mediaIds;
    }
    if (payload.metadata?.visibility) {
      body.visibility = payload.metadata.visibility;
    }
    if (payload.metadata?.spoilerText) {
      body.spoiler_text = payload.metadata.spoilerText;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/json",
    };
    // Mastodon answers a repeat of this key (for about an hour) with the post
    // it already made instead of a new one.
    if (payload.idempotencyKey) headers["Idempotency-Key"] = payload.idempotencyKey;

    const res = await this.call(
      `${instance}/api/v1/statuses`,
      { method: "POST", headers, body: JSON.stringify(body), timeoutMs: CREATE_TIMEOUT_MS },
      "create",
    );
    const data = await this.readJson(res);
    // A 2xx means the post was made; without an id we cannot record it, and
    // retrying would make a second one.
    if (data?.id == null) throw unconfirmedCreate(SVC, "the instance's reply could not be read");

    return {
      platformPostId: String(data.id),
      url: data.url,
      metadata: {
        createdAt: data.created_at,
        visibility: data.visibility,
      },
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const instance = this.getInstanceFromToken(tokens);
    await this.call(
      `${instance}/api/v1/statuses/${encodeURIComponent(platformPostId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tokens.accessToken}` }, timeoutMs: READ_TIMEOUT_MS },
      "read",
    );
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const instance = this.getInstanceFromToken(tokens);
    const res = await this.call(
      `${instance}/api/v1/accounts/verify_credentials`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` }, timeoutMs: READ_TIMEOUT_MS },
      "read",
    );
    const data = await this.readJson(res);
    if (data?.id == null) throw new Error("The Mastodon instance's profile reply could not be read.");

    return {
      id: data.id,
      name: data.display_name || data.username,
      username: data.acct,
      avatar: data.avatar,
    };
  }

  private async uploadMedia(
    tokens: OAuthTokens,
    instance: string,
    mediaUrl: string,
    declaredType?: string
  ): Promise<string> {
    // The post's own media file, from OUR storage — not a user-named host.
    let file: Blob;
    let mediaType: string;
    try {
      const mediaRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
      if (!mediaRes.ok) throw new Error(`storage answered HTTP ${mediaRes.status}`);
      mediaType = mediaRes.headers.get("content-type") || declaredType || "image/jpeg";
      file = await mediaRes.blob();
    } catch (err) {
      console.warn(`[Mastodon] could not read media for upload: ${(err as Error)?.message}`);
      // No status code in the message: the worker's classifier reads "403" as a permission error.
      throw retryableMediaFailure(SVC, "the attached file could not be read from storage", err);
    }

    const ext = (mediaType.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
    const formData = new FormData();
    formData.append("file", file, `upload.${ext}`);

    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const res = await this.call(
      `${instance}/api/v2/media`,
      { method: "POST", headers: auth, body: formData, timeoutMs: MEDIA_TIMEOUT_MS },
      "media",
    );
    const data = await this.readJson(res);
    if (data?.id == null) throw retryableMediaFailure(SVC, "the reply could not be read");
    const id = String(data.id);

    // 202 = accepted but still processing (video, large images). Attaching it
    // before it is ready fails the post, so wait for it.
    if (res.status === 202) await this.waitForMedia(instance, auth, id);
    return id;
  }

  private async waitForMedia(instance: string, auth: Record<string, string>, id: string): Promise<void> {
    for (let i = 0; i < MEDIA_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, MEDIA_POLL_INTERVAL_MS));
      let res: Response;
      try {
        res = await userHostFetch(`${instance}/api/v1/media/${encodeURIComponent(id)}`, {
          headers: auth,
          timeoutMs: READ_TIMEOUT_MS,
        });
      } catch (err) {
        throw userHostFailure(err, SVC, "media");
      }
      if (res.status === 206) continue;
      if (res.ok) return;
      throw await userHostStatusFailure(res, SVC, "media");
    }
    throw retryableMediaFailure(SVC, "the instance was still processing it");
  }
}
