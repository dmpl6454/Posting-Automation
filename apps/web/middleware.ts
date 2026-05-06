import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

// SECURITY: do NOT fall back to a hardcoded literal — that would allow
// anyone to forge admin JWTs if the env var is unset. We accept either
// ADMIN_JWT_SECRET or (the more commonly set) NEXTAUTH_SECRET, but if
// neither is present we refuse to authenticate any admin tokens at all.
const _adminSecret = process.env.ADMIN_JWT_SECRET || process.env.NEXTAUTH_SECRET;
const ADMIN_JWT_SECRET = _adminSecret ? new TextEncoder().encode(_adminSecret) : null;
const ADMIN_COOKIE = "admin-token";

// Check for NextAuth session cookie (works with both v4 and v5)
function hasSessionCookie(request: NextRequest): boolean {
  return !!(
    request.cookies.get("next-auth.session-token")?.value ||
    request.cookies.get("__Secure-next-auth.session-token")?.value ||
    request.cookies.get("authjs.session-token")?.value ||
    request.cookies.get("__Secure-authjs.session-token")?.value
  );
}

async function verifyAdminToken(request: NextRequest) {
  if (!ADMIN_JWT_SECRET) {
    // Refuse to verify any token if no secret is configured — this prevents
    // accepting unsigned/forged tokens in misconfigured environments.
    console.error("[middleware] ADMIN_JWT_SECRET / NEXTAUTH_SECRET unset — refusing all admin auth");
    return null;
  }
  const token = request.cookies.get(ADMIN_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, ADMIN_JWT_SECRET);
    return payload.isSuperAdmin ? payload : null;
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isAuthenticated = hasSessionCookie(request);

  // Redirect authenticated users from public pages to dashboard
  if (isAuthenticated && (pathname === "/" || pathname === "/login" || pathname === "/register")) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Admin route guard — uses custom admin JWT cookie (bypasses NextAuth)
  if (pathname.startsWith("/admin") && pathname !== "/admin/login") {
    const admin = await verifyAdminToken(request);
    if (!admin) {
      const loginUrl = new URL("/admin/login", request.url);
      return NextResponse.redirect(loginUrl);
    }
  }

  const response = NextResponse.next();

  // Security headers
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // Content Security Policy
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    "frame-ancestors 'none'",
  ].join("; ");
  response.headers.set("Content-Security-Policy", csp);

  // HSTS (only in production)
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  return response;
}

export const config = {
  matcher: [
    // Apply to all routes except static files, auth API, and favicon
    "/((?!_next/static|_next/image|favicon.ico|api/auth|api/admin).*)",
  ],
};
