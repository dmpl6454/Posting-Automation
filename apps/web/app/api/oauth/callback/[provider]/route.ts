import { NextResponse } from "next/server";
import { prisma, encryptToken, resolveChannelErrorsOnReconnect } from "@postautomation/db";
import { getSocialProvider, FacebookProvider, InstagramProvider, LinkedInProvider, verifyState, fetchMetaTokenWindow } from "@postautomation/social";
// Deep import via @postautomation/api (a declared, transpiled web dependency):
// apps/web has no direct dep on @postautomation/queue, so the api package
// bridges the avatar-cache enqueue.
import { enqueueAvatarCacheJobs } from "@postautomation/api/src/lib/avatar-cache";
import { markChannelsMissingFromGrant } from "@postautomation/api/src/lib/orphaned-grant";
import { auth } from "~/lib/auth";

/**
 * Best-effort: correct the Insights verdict on channels this consent did NOT
 * include. Without it, a page left unticked keeps a stale "your access token was
 * rejected — reconnect" verdict that no reconnect can ever clear, because the
 * upsert loop above only visits pages the platform actually returned. See
 * orphaned-grant.ts for the prod evidence.
 *
 * MUST NOT throw: the channels are already saved by this point, and a bookkeeping
 * failure must never turn a successful connect into an error redirect.
 */
async function correctOrphanedGrantVerdicts(
  organizationId: string,
  platform: string,
  grantedPlatformIds: string[],
  platformLabel: string
): Promise<void> {
  try {
    const n = await markChannelsMissingFromGrant(
      prisma as never,
      organizationId,
      platform,
      grantedPlatformIds,
      platformLabel
    );
    if (n > 0) {
      console.info(
        `[oauth/${platform.toLowerCase()}] corrected ${n} channel(s) left out of this consent`
      );
    }
  } catch (err: any) {
    console.warn(
      `[oauth/${platform.toLowerCase()}] orphaned-grant correction failed (non-fatal): ${err?.message ?? err}`
    );
  }
}

/**
 * Best-effort: queue avatar re-cache jobs for freshly connected channels so
 * their platform CDN avatar URLs get pinned to durable S3 storage promptly
 * (IG/FB signed URLs expire in days). Fire-and-forget — must NEVER break or
 * delay the connect flow.
 */
function queueAvatarCache(channelIds: string[]): void {
  try {
    void enqueueAvatarCacheJobs(channelIds, "connect").catch((err: any) => {
      console.warn(`[oauth] avatar-cache enqueue failed (non-fatal): ${err?.message ?? err}`);
    });
  } catch (err: any) {
    console.warn(`[oauth] avatar-cache enqueue failed (non-fatal): ${err?.message ?? err}`);
  }
}

// SECURITY: do not reflect raw provider error strings into the redirect URL.
// They can include access tokens, internal URLs, or upstream debug info.
// Use opaque codes; log the real message server-side.
function genericErrorRedirect(code: string): NextResponse {
  return NextResponse.redirect(
    `${process.env.APP_URL}/dashboard/channels?error=${encodeURIComponent(code)}`
  );
}

async function assertSessionMatchesState(
  organizationId: string,
  expectedUserId: string
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const session = await auth();
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return { ok: false, reason: "not_authenticated" };
  if (userId !== expectedUserId) return { ok: false, reason: "user_mismatch" };
  // Verify the user is actually a member of the org embedded in state.
  const membership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { userId: true },
  });
  if (!membership) return { ok: false, reason: "not_a_member" };
  return { ok: true, userId };
}

export async function GET(
  req: Request,
  { params }: { params: { provider: string } }
) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");

  if (error) {
    console.warn(`[oauth/${params.provider}] provider returned error: ${error}`);
    return genericErrorRedirect("oauth_provider_error");
  }

  // ------------------------------------------------------------------
  // Twitter uses OAuth 1.0a — callback params are different from OAuth 2.0
  // Twitter sends: oauth_token, oauth_verifier, and our custom twitterstate
  // ------------------------------------------------------------------
  const isTwitter = params.provider.toLowerCase() === "twitter";
  const oauthVerifier = url.searchParams.get("oauth_verifier");
  const oauthToken = url.searchParams.get("oauth_token"); // request token
  const twitterState = url.searchParams.get("twitterstate");

  if (isTwitter && oauthVerifier && oauthToken) {
    // OAuth 1.0a Twitter callback
    if (!twitterState) {
      return genericErrorRedirect("missing_state");
    }

    try {
      // SECURITY: verify the signed state. Throws on tampered/expired state.
      const statePayload = verifyState(twitterState);
      const { organizationId, userId: stateUserId } = statePayload;

      // SECURITY: require an authenticated session and verify the user
      // is the same one who initiated the flow AND is a member of the org.
      const sessionCheck = await assertSessionMatchesState(organizationId, stateUserId);
      if (!sessionCheck.ok) {
        console.warn(`[oauth/twitter] session check failed: ${sessionCheck.reason}`);
        return genericErrorRedirect(`auth_${sessionCheck.reason}`);
      }

      const platform = "TWITTER";
      const provider = getSocialProvider(platform as any);

      // Fix #19: guard against missing env vars
      const twitterClientId = process.env.TWITTER_CLIENT_ID;
      const twitterClientSecret = process.env.TWITTER_CLIENT_SECRET;
      if (!twitterClientId || !twitterClientSecret) {
        return NextResponse.redirect(
          `${process.env.APP_URL}/dashboard/channels?error=platform_not_configured&platform=twitter`
        );
      }

      const config = {
        clientId: twitterClientId,
        clientSecret: twitterClientSecret,
        callbackUrl: `${process.env.APP_URL}/api/oauth/callback/twitter`,
        scopes: [],
      };

      // exchangeCodeForTokens(verifier, config, requestToken) for OAuth 1.0a
      const tokens = await provider.exchangeCodeForTokens(oauthVerifier, config, oauthToken);
      const profile = await provider.getProfile(tokens);

      const twitterChannel = await prisma.channel.upsert({
        where: {
          organizationId_platform_platformId: {
            organizationId,
            platform: "TWITTER",
            platformId: profile.id,
          },
        },
        update: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || null,
          tokenExpiresAt: null,
          scopes: ["tweet.read", "tweet.write", "media.write"],
          name: profile.name,
          username: profile.username || null,
          avatar: profile.avatar || null,
          isActive: true,
          // Reconnect REVIVES a soft-deleted channel: clearing this preserves the
          // channel\'s entire post history and avoids creating a duplicate row.
          disconnectedAt: null,
        },
        create: {
          organizationId,
          platform: "TWITTER",
          platformId: profile.id,
          name: profile.name,
          username: profile.username || null,
          avatar: profile.avatar || null,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || null,
          tokenExpiresAt: null,
          scopes: ["tweet.read", "tweet.write", "media.write"],
        },
      });

      // Fresh token → clear this channel's open token/auth monitoring errors.
      await resolveChannelErrorsOnReconnect(prisma, twitterChannel.id);
      queueAvatarCache([twitterChannel.id]);

      return NextResponse.redirect(
        `${process.env.APP_URL}/dashboard/channels?success=connected&platform=twitter`
      );
    } catch (err: any) {
      console.error("Twitter OAuth 1.0a callback error:", err);
      return genericErrorRedirect("oauth_failed");
    }
  }

  // ------------------------------------------------------------------
  // OAuth 2.0 flow (Facebook, Instagram, LinkedIn, etc.)
  // ------------------------------------------------------------------
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return genericErrorRedirect("missing_params");
  }

  try {
    // SECURITY: verify the signed state. Throws on tampered or expired state.
    const statePayload = verifyState(state);
    const { organizationId, userId: stateUserId, codeVerifier } = statePayload;

    // SECURITY: enforce session + membership match.
    const sessionCheck = await assertSessionMatchesState(organizationId, stateUserId);
    if (!sessionCheck.ok) {
      console.warn(`[oauth/${params.provider}] session check failed: ${sessionCheck.reason}`);
      return genericErrorRedirect(`auth_${sessionCheck.reason}`);
    }

    const platform = params.provider.toUpperCase();
    const provider = getSocialProvider(platform as any);

    const envPrefix = platform;
    const oauthClientId = process.env[`${envPrefix}_CLIENT_ID`];
    const oauthClientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];

    // Fix #19: guard against missing env vars in OAuth callback
    if (!oauthClientId || !oauthClientSecret) {
      return NextResponse.redirect(
        `${process.env.APP_URL}/dashboard/channels?error=platform_not_configured&platform=${params.provider}`
      );
    }

    const config = {
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      // Must byte-match the redirect_uri used at authorize time, which lowercases
      // the provider (see channel.router.ts getOAuthUrl). Meta rejects mismatches.
      callbackUrl: `${process.env.APP_URL}/api/oauth/callback/${params.provider.toLowerCase()}`,
      scopes: [],
    };

    const tokens = await provider.exchangeCodeForTokens(code, config, codeVerifier);

    // Get profile info.
    // INSTAGRAM is deliberately skipped here: the IG branch below builds its
    // channels from getAllInstagramAccounts() (which returns [] gracefully when
    // no IG Business account is linked) and never reads `profile`. Calling
    // InstagramProvider.getProfile() here would call getInstagramBusinessAccountId(),
    // which THROWS "No Instagram Business Account found…" for personal-IG users —
    // that throw was being caught by the outer catch and mislabelled as the
    // generic `oauth_failed` toast, making the clean `ig_no_business_account`
    // guard below unreachable (dead code). Skipping it lets the specific,
    // actionable message surface. (FACEBOOK keeps getProfile — its profile read
    // succeeds even for a user with no Pages, so it does not pre-empt the
    // fb_no_pages branch.)
    const profile =
      platform === "INSTAGRAM"
        ? ({ id: "", name: "" } as Awaited<ReturnType<typeof provider.getProfile>>)
        : await provider.getProfile(tokens);

    // Meta's 90-day DATA-ACCESS window. Captured ONCE per consent (the same user
    // token backs every Page / IG account granted here), never per channel — a
    // per-channel debug_token sweep over ~1300 channels trips Meta's app-level
    // rate limit. This is the clock that actually kills Meta insights every ~3
    // months: `expires_at` is genuinely "never" (so tokenExpiresAt is correctly
    // NULL), while data access silently lapses at +90 days. A server-side
    // refresh CANNOT extend it — verified: fb_exchange_token returns a token with
    // an identical data_access_expires_at — so the only cure is this reconnect,
    // and the only useful thing we can do is record the deadline and warn ahead
    // of it. Best-effort: must never break a connect.
    const metaTokenWindow =
      platform === "FACEBOOK" || platform === "INSTAGRAM"
        ? await fetchMetaTokenWindow(tokens.accessToken, oauthClientId, oauthClientSecret).catch(
            () => null
          )
        : null;
    const metaWindowMeta = metaTokenWindow?.dataAccessExpiresAt
      ? {
          dataAccessExpiresAt: metaTokenWindow.dataAccessExpiresAt.toISOString(),
          dataAccessCheckedAt: new Date().toISOString(),
        }
      : {};

    // For Facebook, fetch and save managed Pages instead of the user account
    if (platform === "FACEBOOK" && provider instanceof FacebookProvider) {
      const pages = await provider.getPages(tokens);

      if (pages.length === 0) {
        // A Facebook user account cannot post to a feed via the Graph API —
        // posting requires a Page the user administers. Surface this clearly
        // instead of creating an unusable channel.
        console.warn(
          "[oauth/facebook] connected user administers no Facebook Pages"
        );
        return NextResponse.redirect(
          `${process.env.APP_URL}/dashboard/channels?error=fb_no_pages&platform=facebook`
        );
      } else {
        // Save each Facebook Page as a separate channel
        const fbChannelIds: string[] = [];
        for (const page of pages) {
          const fbChannel = await prisma.channel.upsert({
            where: {
              organizationId_platform_platformId: {
                organizationId,
                platform: "FACEBOOK",
                platformId: page.id,
              },
            },
            update: {
              accessToken: page.accessToken,
              refreshToken: page.accessToken, // Page tokens don't expire if user token is long-lived
              tokenExpiresAt: null,
              scopes: tokens.scopes || [],
              name: page.name,
              avatar: page.avatar || null,
              isActive: true,
              // Reconnect REVIVES a soft-deleted channel: clearing this preserves the
              // channel\'s entire post history and avoids creating a duplicate row.
              disconnectedAt: null,
              // SECURITY: encrypt the long-lived user token at rest in metadata
              // (the accessToken column is encrypted via the Prisma extension; metadata is not).
              // NOTE: userAccessToken is stored encrypted; any future reader MUST decryptToken()
              // it before use. It is currently written here but read nowhere.
              metadata: { pageId: page.id, userAccessToken: encryptToken(tokens.accessToken), ...metaWindowMeta },
            },
            create: {
              organizationId,
              platform: "FACEBOOK",
              platformId: page.id,
              name: page.name,
              avatar: page.avatar || null,
              accessToken: page.accessToken,
              refreshToken: page.accessToken,
              tokenExpiresAt: null,
              scopes: tokens.scopes || [],
              // SECURITY: encrypt the long-lived user token at rest in metadata
              // (the accessToken column is encrypted via the Prisma extension; metadata is not).
              // NOTE: userAccessToken is stored encrypted; any future reader MUST decryptToken()
              // it before use. It is currently written here but read nowhere.
              metadata: { pageId: page.id, userAccessToken: encryptToken(tokens.accessToken), ...metaWindowMeta },
            },
          });
          // Fresh token → clear this channel's open token/auth monitoring errors.
          await resolveChannelErrorsOnReconnect(prisma, fbChannel.id);
          fbChannelIds.push(fbChannel.id);
        }
        queueAvatarCache(fbChannelIds);
        // Pages the user did NOT tick are never visited by the loop above, so
        // their stale "reconnect this channel" verdict would otherwise outlive
        // every future reconnect.
        await correctOrphanedGrantVerdicts(
          organizationId,
          "FACEBOOK",
          pages.map((p) => p.id),
          "Facebook"
        );
      }

      const count = pages.length || 1;
      return NextResponse.redirect(
        `${process.env.APP_URL}/dashboard/channels?success=connected&platform=${params.provider}&pages=${count}`
      );
    }

    // For Instagram, fetch and save ALL linked Instagram Business Accounts
    if (platform === "INSTAGRAM" && provider instanceof InstagramProvider) {
      const igAccounts = await provider.getAllInstagramAccounts(tokens);

      if (igAccounts.length === 0) {
        console.warn(
          "[oauth/instagram] connected user has no IG Business Account linked to a Page"
        );
        return NextResponse.redirect(
          `${process.env.APP_URL}/dashboard/channels?error=ig_no_business_account&platform=instagram`
        );
      }

      const igChannelIds: string[] = [];
      for (const ig of igAccounts) {
        const igChannel = await prisma.channel.upsert({
          where: {
            organizationId_platform_platformId: {
              organizationId,
              platform: "INSTAGRAM",
              platformId: ig.id,
            },
          },
          update: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || null,
            tokenExpiresAt: tokens.expiresAt || null,
            scopes: tokens.scopes || [],
            name: ig.name,
            username: ig.username || null,
            avatar: ig.avatar || null,
            isActive: true,
            // Reconnect REVIVES a soft-deleted channel: clearing this preserves the
            // channel\'s entire post history and avoids creating a duplicate row.
            disconnectedAt: null,
            metadata: { igUserId: ig.id, ...metaWindowMeta },
          },
          create: {
            organizationId,
            platform: "INSTAGRAM",
            platformId: ig.id,
            name: ig.name,
            username: ig.username || null,
            avatar: ig.avatar || null,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || null,
            tokenExpiresAt: tokens.expiresAt || null,
            scopes: tokens.scopes || [],
            metadata: { igUserId: ig.id, ...metaWindowMeta },
          },
        });
        // Fresh token → clear this channel's open token/auth monitoring errors.
        await resolveChannelErrorsOnReconnect(prisma, igChannel.id);
        igChannelIds.push(igChannel.id);
      }
      queueAvatarCache(igChannelIds);
      // Same orphan class as Facebook: an IG account resolves through a Page, so
      // an unticked Page silently drops its IG account from this consent too.
      await correctOrphanedGrantVerdicts(
        organizationId,
        "INSTAGRAM",
        igAccounts.map((a) => a.id),
        "Instagram"
      );

      return NextResponse.redirect(
        `${process.env.APP_URL}/dashboard/channels?success=connected&platform=${params.provider}&pages=${igAccounts.length}`
      );
    }

    // For LinkedIn, save personal profile + managed company pages
    if (platform === "LINKEDIN" && provider instanceof LinkedInProvider) {
      // Save personal profile
      const liPersonal = await prisma.channel.upsert({
        where: {
          organizationId_platform_platformId: {
            organizationId,
            platform: "LINKEDIN",
            platformId: profile.id,
          },
        },
        update: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || null,
          tokenExpiresAt: tokens.expiresAt || null,
          scopes: tokens.scopes || [],
          name: `${profile.name} (Personal)`,
          avatar: profile.avatar || null,
          isActive: true,
          // Reconnect REVIVES a soft-deleted channel: clearing this preserves the
          // channel\'s entire post history and avoids creating a duplicate row.
          disconnectedAt: null,
        },
        create: {
          organizationId,
          platform: "LINKEDIN",
          platformId: profile.id,
          name: `${profile.name} (Personal)`,
          avatar: profile.avatar || null,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || null,
          tokenExpiresAt: tokens.expiresAt || null,
          scopes: tokens.scopes || [],
        },
      });
      // Fresh token → clear this channel's open token/auth monitoring errors.
      await resolveChannelErrorsOnReconnect(prisma, liPersonal.id);
      const liChannelIds: string[] = [liPersonal.id];

      // Fetch and save LinkedIn Pages (organizations)
      let pageCount = 0;
      try {
        const pages = await provider.getPages(tokens);
        for (const page of pages) {
          const liPage = await prisma.channel.upsert({
            where: {
              organizationId_platform_platformId: {
                organizationId,
                platform: "LINKEDIN",
                platformId: `org-${page.id}`,
              },
            },
            update: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken || null,
              tokenExpiresAt: tokens.expiresAt || null,
              scopes: tokens.scopes || [],
              name: `${page.name} (Page)`,
              avatar: page.avatar || null,
              isActive: true,
              // Reconnect REVIVES a soft-deleted channel: clearing this preserves the
              // channel\'s entire post history and avoids creating a duplicate row.
              disconnectedAt: null,
              metadata: { orgId: page.id },
            },
            create: {
              organizationId,
              platform: "LINKEDIN",
              platformId: `org-${page.id}`,
              name: `${page.name} (Page)`,
              avatar: page.avatar || null,
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken || null,
              tokenExpiresAt: tokens.expiresAt || null,
              scopes: tokens.scopes || [],
              metadata: { orgId: page.id },
            },
          });
          await resolveChannelErrorsOnReconnect(prisma, liPage.id);
          liChannelIds.push(liPage.id);
          pageCount++;
        }
      } catch (e: any) {
        console.warn(`[LinkedIn] Failed to fetch pages: ${e.message}`);
      }
      queueAvatarCache(liChannelIds);

      return NextResponse.redirect(
        `${process.env.APP_URL}/dashboard/channels?success=connected&platform=linkedin&pages=${1 + pageCount}`
      );
    }

    // For all other platforms, save the single account
    // Store token metadata (e.g. WordPress blog_id) in channel metadata
    const channelMetadata = (tokens as any).metadata || undefined;

    const genericChannel = await prisma.channel.upsert({
      where: {
        organizationId_platform_platformId: {
          organizationId,
          platform: platform as any,
          platformId: profile.id,
        },
      },
      update: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || null,
        tokenExpiresAt: tokens.expiresAt || null,
        scopes: tokens.scopes || [],
        name: profile.name,
        username: profile.username || null,
        avatar: profile.avatar || null,
        isActive: true,
        // Reconnect REVIVES a soft-deleted channel: clearing this preserves the
        // channel\'s entire post history and avoids creating a duplicate row.
        disconnectedAt: null,
        ...(channelMetadata && { metadata: channelMetadata }),
      },
      create: {
        organizationId,
        platform: platform as any,
        platformId: profile.id,
        name: profile.name,
        username: profile.username || null,
        avatar: profile.avatar || null,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || null,
        tokenExpiresAt: tokens.expiresAt || null,
        scopes: tokens.scopes || [],
        ...(channelMetadata && { metadata: channelMetadata }),
      },
    });
    // Fresh token → clear this channel's open token/auth monitoring errors.
    await resolveChannelErrorsOnReconnect(prisma, genericChannel.id);
    queueAvatarCache([genericChannel.id]);

    return NextResponse.redirect(
      `${process.env.APP_URL}/dashboard/channels?success=connected&platform=${params.provider}`
    );
  } catch (err: any) {
    console.error(`OAuth callback error for ${params.provider}:`, err);
    // Map known errors to a more useful, actionable code.
    const msg = err?.message ?? "";
    const code = /State expired/i.test(msg)
      ? "state_expired"
      : /Invalid state/i.test(msg)
      ? "invalid_state"
      : // Defense-in-depth: any "no IG Business account" throw that reaches here
        // (e.g. from a deeper Instagram Graph path) gets the specific, actionable
        // toast instead of the generic "Sign-in failed". Primary fix is skipping
        // the front-loaded getProfile for INSTAGRAM above.
        /No Instagram Business Account|Instagram Professional account/i.test(msg)
      ? "ig_no_business_account"
      : "oauth_failed";
    return genericErrorRedirect(code);
  }
}
