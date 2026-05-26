import { NextResponse } from "next/server";
import { auth } from "~/lib/auth";
import { openApiSpec } from "@postautomation/api";

// Fix #80: serve the spec to authenticated OWNER/ADMIN users; otherwise gate with env var.
// Public OpenAPI is fine (no secrets baked in), so the default is to allow
// OWNER/ADMIN access. The EXPOSE_OPENAPI env var still lets ops open it completely.
export async function GET() {
  // Allow if explicitly opened via env var (e.g. for public API docs hosting)
  if (process.env.EXPOSE_OPENAPI === "true") {
    return NextResponse.json(openApiSpec, {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // Otherwise require an authenticated session with OWNER or ADMIN role
  const session = await auth();
  const role = (session?.user as any)?.role as string | undefined;
  const isAllowed = role === "OWNER" || role === "ADMIN" || (session?.user as any)?.isSuperAdmin;

  if (!isAllowed) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(openApiSpec, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
