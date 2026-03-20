import { NextResponse } from "next/server";
import { prisma } from "@postautomation/db";
import { getSocialProvider, FacebookProvider, InstagramProvider } from "@postautomation/social";

export async function GET(
  req: Request,
  { params }: { params: { provider: string } }
) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      `${process.env.APP_URL}/dashboard/channels?error=${encodeURIComponent(error)}`
    );
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
      return NextResponse.redirect(
        `${process.env.APP_URL}/dashboard/channels?error=missing_twitter_state`
      );
    }

    try {
      const organizationId = twitterState.split(":")[1];
      if (!organizationId) throw new Error("Invalid twitterstate: missing organization ID");

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
      return NextResponse.redirect(
        `${process.env.APP_URL}/dashboard/channels?error=${encodeURIComponent(err.message)}`
      );
    }
  }

  // ------------------------------------------------------------------
  // OAuth 2.0 flow (Facebook, Instagram, LinkedIn, etc.)
  // ------------------------------------------------------------------
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(
      `${process.env.APP_URL}/dashboard/channels?error=missing_params`
    );
  }

  try {
    // Extract org ID and optional PKCE verifier from state
    // State format: "randomhex:orgId" or "randomhex:orgId|pkce:verifier"
    let codeVerifier: string | undefined;
    let cleanState = state;

    const pkceIndex = state.indexOf("|pkce:");
    if (pkceIndex !== -1) {
      codeVerifier = state.slice(pkceIndex + 6);
      cleanState = state.slice(0, pkceIndex);
    }

    const organizationId = cleanState.split(":")[1];
    if (!organizationId) {
      throw new Error("Invalid state: missing organization ID");
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

    // For all other platforms, save the single account
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
      },
    });

    return NextResponse.redirect(
      `${process.env.APP_URL}/dashboard/channels?success=connected&platform=${params.provider}`
    );
  } catch (err: any) {
    console.error(`OAuth callback error for ${params.provider}:`, err);
    return NextResponse.redirect(
      `${process.env.APP_URL}/dashboard/channels?error=${encodeURIComponent(err.message)}`
    );
  }
}
