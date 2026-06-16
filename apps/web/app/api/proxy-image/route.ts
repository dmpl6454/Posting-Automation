import { NextResponse } from "next/server";
import { auth } from "~/lib/auth";
import { safeFetchPublicImage } from "@postautomation/ai";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Auth guard — don't be an open proxy.
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  // SSRF gate: safeFetchPublicImage blocks private/loopback/metadata hosts and
  // non-image content-types. Returns null on any failure (fail-closed).
  const result = await safeFetchPublicImage(url, { timeoutMs: 10_000 });
  if (!result) {
    return NextResponse.json({ error: "Could not fetch image" }, { status: 400 });
  }

  const bytes = Buffer.from(result.base64, "base64");
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": result.mimeType,
      "Cache-Control": "private, max-age=300",
      "Content-Length": String(bytes.byteLength),
    },
  });
}
