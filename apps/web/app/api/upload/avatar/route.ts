import { NextResponse } from "next/server";
import { auth } from "~/lib/auth";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.user.id as string;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "bad_type" }, { status: 415 });
  }

  // Pre-flight: surface a clear config error instead of a silent/opaque S3 failure (audit #17)
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "";
  if (!accessKeyId || !secretAccessKey) {
    console.error("[upload/avatar] S3 credentials are not configured (S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY)");
    return NextResponse.json({ error: "Storage is not configured. Contact your administrator." }, { status: 503 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (err: any) {
    return NextResponse.json({ error: `Failed to read file: ${err?.message ?? "body too large or corrupted"}` }, { status: 413 });
  }
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const key = `avatars/${userId}-${Date.now()}.${ext}`;

  const BUCKET = process.env.S3_BUCKET || "postautomation-media";
  const s3 = new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: file.type,
        ContentLength: buffer.length,
      })
    );
  } catch (err: any) {
    console.error("[upload/avatar] S3 upload failed:", err?.message);
    return NextResponse.json({ error: `Storage upload failed: ${err?.message ?? "unknown S3 error"}` }, { status: 502 });
  }

  const url = process.env.S3_PUBLIC_URL
    ? `${process.env.S3_PUBLIC_URL}/${key}`
    : `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${BUCKET}/${key}`;

  return NextResponse.json({ url });
}
