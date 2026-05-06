import { NextResponse } from "next/server";
import { openApiSpec } from "@postautomation/api";

// SECURITY: in production this endpoint exposes the full internal route
// inventory (recon aid for attackers). Gate it to non-prod environments
// or require an authenticated super-admin to view it.
export async function GET() {
  if (process.env.NODE_ENV === "production" && process.env.EXPOSE_OPENAPI !== "true") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(openApiSpec, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
