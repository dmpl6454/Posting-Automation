import { NextResponse } from "next/server";
import { prisma } from "@postautomation/db";
import { getSocialProvider, FacebookProvider, InstagramProvider, LinkedInProvider, verifyState } from "@postautomation/social";
import { auth } from "~/lib/auth";

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
      const config = {
        clientId: process.env.TWITTER_CLIENT_ID || "",
        clientSecret: process.env.TWITTER_CLIENT_SECRET || "",
        callbackUrl: `${process.env.APP_URL}/api/oauth/callback/twitter`,
        scopes: [],
      };

      // exchangeCodeForTokens(verifier, config, requestToken) for OAuth 1.0a
      const tokens = await provider.exchangeCodeForTokens(oauthVerifier, config, oauthToken);
      const profile = await provider.getProfile(tokens);

      await prisma.channel.upsert({
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
    const config = {
      clientId: process.env[`${envPrefix}_CLIENT_ID`] || "",
      clientSecret: process.env[`${envPrefix}_CLIENT_SECRET`] || "",
      callbackUrl: `${process.env.APP_URL}/api/oauth/callback/${params.provider}`,
      scopes: [],
    };

    const tokens = await provider.exchangeCodeForTokens(code, config, codeVerifier);

    // Get profile info
    const profile = await provider.getProfile(tokens);

    // For Facebook, fetch and save managed Pages instead of the user account
    if (platform === "FACEBOOK" && provider instanceof FacebookProvider) {
      const pages = await provider.getPages(tokens);

      if (pages.length === 0) {
        // No pages found — save user account as fallback
        await prisma.channel.upsert({
          where: {
            organizationId_platform_platformId: {
              organizationId,
              platform: "FACEBOOK",
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
          },
          create: {
            organizationId,
            platform: "FACEBOOK",
            platformId: profile.id,
            name: profile.name,
            username: profile.username || null,
            avatar: profile.avatar || null,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || null,
            tokenExpiresAt: tokens.expiresAt || null,
            scopes: tokens.scopes || [],
          },
        });
      } else {
        // Save each Facebook Page as a separate channel
        for (const page of pages) {
          await prisma.channel.upsert({
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
              metadata: { pageId: page.id, userAccessToken: tokens.accessToken },
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
              metadata: { pageId: page.id, userAccessToken: tokens.accessToken },
            },
          });
        }
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
        throw new Error("No Instagram Business Account found. Ensure a Facebook Page is connected to an Instagram Professional account.");
      }

      for (const ig of igAccounts) {
        await prisma.channel.upsert({
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
            metadata: { igUserId: ig.id },
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
            metadata: { igUserId: ig.id },
          },
        });
      }

      return NextResponse.redirect(
        `${process.env.APP_URL}/dashboard/channels?success=connected&platform=${params.provider}&pages=${igAccounts.length}`
      );
    }

    // For LinkedIn, save personal profile + managed company pages
    if (platform === "LINKEDIN" && provider instanceof LinkedInProvider) {
      // Save personal profile
      await prisma.channel.upsert({
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

      // Fetch and save LinkedIn Pages (organizations)
      let pageCount = 0;
      try {
        const pages = await provider.getPages(tokens);
        for (const page of pages) {
          await prisma.channel.upsert({
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
          pageCount++;
        }
      } catch (e: any) {
        console.warn(`[LinkedIn] Failed to fetch pages: ${e.message}`);
      }

      return NextResponse.redirect(
        `${process.env.APP_URL}/dashboard/channels?success=connected&platform=linkedin&pages=${1 + pageCount}`
      );
    }

    // For all other platforms, save the single account
    // Store token metadata (e.g. WordPress blog_id) in channel metadata
    const channelMetadata = (tokens as any).metadata || undefined;

    await prisma.channel.upsert({
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

    return NextResponse.redirect(
      `${process.env.APP_URL}/dashboard/channels?success=connected&platform=${params.provider}`
    );
  } catch (err: any) {
    console.error(`OAuth callback error for ${params.provider}:`, err);
    // Map known state-verification errors to a slightly more useful code.
    const code = /State expired/i.test(err?.message)
      ? "state_expired"
      : /Invalid state/i.test(err?.message)
      ? "invalid_state"
      : "oauth_failed";
    return genericErrorRedirect(code);
  }
}
