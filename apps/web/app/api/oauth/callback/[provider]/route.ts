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
      `${process.env.APP_URL}/channels?error=${encodeURIComponent(error)}`
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${process.env.APP_URL}/channels?error=missing_params`
    );
  }

  try {
    // Extract org ID from state
    const organizationId = state.split(":")[1];
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

    // Exchange code for tokens
    const tokens = await provider.exchangeCodeForTokens(code, config);

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
      `${process.env.APP_URL}/channels?success=connected&platform=${params.provider}`
    );
  } catch (err: any) {
    console.error(`OAuth callback error for ${params.provider}:`, err);
    return NextResponse.redirect(
      `${process.env.APP_URL}/channels?error=${encodeURIComponent(err.message)}`
    );
  }
}
