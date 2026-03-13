import { getToken } from "next-auth/jwt";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  return NextResponse.json({
    hasToken: !!token,
    tokenKeys: token ? Object.keys(token) : [],
    id: token?.id,
    email: token?.email,
    isSuperAdmin: token?.isSuperAdmin,
    isBanned: token?.isBanned,
    sub: token?.sub,
  });
}
