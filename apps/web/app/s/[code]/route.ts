import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@postautomation/db";

export async function GET(
  request: NextRequest,
  { params }: { params: { code: string } }
) {
  const { code } = params;

  // Look up short link by code
  const shortLink = await prisma.shortLink.findUnique({
    where: { code },
  });

  // Not found or expired
  if (!shortLink) {
    return new NextResponse("Not Found", { status: 404 });
  }

  if (shortLink.expiresAt && shortLink.expiresAt < new Date()) {
    return new NextResponse("Link Expired", { status: 404 });
  }

  // Capture click data from headers
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const userAgent = request.headers.get("user-agent") || undefined;
  const referer = request.headers.get("referer") || undefined;

  // Validate scheme to prevent open-redirect to dangerous protocols
  try {
    const proto = new URL(shortLink.originalUrl).protocol;
    if (proto !== "http:" && proto !== "https:") {
      return new NextResponse("Invalid link", { status: 400 });
    }
  } catch {
    return new NextResponse("Invalid link", { status: 400 });
  }

  // Await click analytics write so data is never silently lost
  try {
    await Promise.all([
      prisma.shortLink.update({
        where: { id: shortLink.id },
        data: {
          clicks: { increment: 1 },
          lastClickedAt: new Date(),
        },
      }),
      prisma.shortLinkClick.create({
        data: {
          shortLinkId: shortLink.id,
          ipAddress: ip,
          userAgent,
          referer,
        },
      }),
    ]);
  } catch (err) {
    console.error("[ShortLink] Failed to record click:", err);
    // Still redirect even if analytics write fails.
  }

  // Redirect to the original URL
  return NextResponse.redirect(shortLink.originalUrl, 302);
}
