import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Check for NextAuth session cookie (works with both v4 and v5)
function hasSessionCookie(request: NextRequest): boolean {
  return !!(
    request.cookies.get("next-auth.session-token")?.value ||
    request.cookies.get("__Secure-next-auth.session-token")?.value ||
    request.cookies.get("authjs.session-token")?.value ||
    request.cookies.get("__Secure-authjs.session-token")?.value
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isAuthenticated = hasSessionCookie(request);

  // Redirect authenticated users from public pages to dashboard.
  // Special case: if an authenticated user hits /login or /register with an
  // ?invite=<token> param, send them directly to /invite/<token> so the
  // accept flow fires instead of silently dropping the token.
  if (isAuthenticated && (pathname === "/" || pathname === "/login" || pathname === "/register")) {
    const inviteToken = request.nextUrl.searchParams.get("invite");
    if (inviteToken && (pathname === "/login" || pathname === "/register")) {
      return NextResponse.redirect(new URL(`/invite/${encodeURIComponent(inviteToken)}`, request.url));
    }
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // BUG-15: redirect UNAUTHENTICATED users away from the app shell to /login.
  // tRPC already authorizes data server-side, but without this the dashboard
  // shell still rendered (HTTP 200) for anonymous visitors. Preserve the
  // originally-requested path as ?callbackUrl so login can bounce back.
  if (!isAuthenticated && pathname.startsWith("/dashboard")) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  // The legacy /admin/login page (custom admin-token auth) was removed —
  // /admin now rides the NextAuth session. Send old bookmarks to /admin.
  if (pathname === "/admin/login") {
    return NextResponse.redirect(new URL("/admin", request.url));
  }

  // Admin route guard — requires a NextAuth session. The cookie check here is
  // presence-only (Edge middleware can't hit the DB); the isSuperAdmin check
  // runs server-side in app/admin/layout.tsx and superAdminProcedure.
  if (!isAuthenticated && pathname.startsWith("/admin")) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next();

  // Security headers
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // Content Security Policy
  // media-src + img-src must allow http: in dev (MinIO on localhost:9000) and https: in prod (S3/CDN)
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: wss:",
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
    "/((?!_next/static|_next/image|favicon.ico|api/auth).*)",
  ],
};
