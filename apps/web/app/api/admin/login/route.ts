import { NextResponse } from "next/server";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { prisma } from "@postautomation/db";

// SECURITY: never fall back to a hardcoded literal. If neither env var
// is set we throw at request time so admin login fails closed instead of
// signing tokens with a public, source-controlled secret.
const _adminSecret = process.env.ADMIN_JWT_SECRET || process.env.NEXTAUTH_SECRET;
const ADMIN_JWT_SECRET = _adminSecret ? new TextEncoder().encode(_adminSecret) : null;
const COOKIE_NAME = "admin-token";

export async function POST(request: Request) {
  try {
    if (!ADMIN_JWT_SECRET) {
      console.error("[admin/login] ADMIN_JWT_SECRET / NEXTAUTH_SECRET unset — refusing to issue admin tokens");
      return NextResponse.json({ error: "Server not configured" }, { status: 500 });
    }

    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: email.toLowerCase().trim(), mode: "insensitive" } },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        password: true,
        isSuperAdmin: true,
        isBanned: true,
        deletedAt: true,
      },
    });

    if (!user || !user.password) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    if (!user.isSuperAdmin) {
      return NextResponse.json({ error: "Not authorized as admin" }, { status: 403 });
    }

    if (user.isBanned) {
      return NextResponse.json({ error: "Account suspended" }, { status: 403 });
    }

    if (user.deletedAt) {
      return NextResponse.json({ error: "Account deleted" }, { status: 403 });
    }

    // Create JWT
    const token = await new SignJWT({
      id: user.id,
      email: user.email,
      name: user.name,
      isSuperAdmin: true,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(ADMIN_JWT_SECRET);

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name },
    });

    response.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });

    return response;
  } catch (error) {
    console.error("Admin login error:", error);
    return NextResponse.json({ error: "Login failed" }, { status: 500 });
  }
}
