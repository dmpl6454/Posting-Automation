import { NextResponse } from "next/server";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";

export async function GET(
  req: Request,
  { params }: { params: { provider: string } }
) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      `${process.env.APP_URL}/dashboard/channels?error=${encodeURIComponent(error)}`
    );
  }

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

    // Extract PKCE verifier if present (used by Twitter/X OAuth2)
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

    // Exchange code for tokens (pass PKCE verifier for Twitter)
    const tokens = await provider.exchangeCodeForTokens(code, config, codeVerifier);

    // Get profile info
    const profile = await provider.getProfile(tokens);

    // Save or update channel
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
