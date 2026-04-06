import { NextResponse } from "next/server";
import { auth } from "~/lib/auth";
import { prisma } from "@postautomation/db";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export const dynamic = "force-dynamic";
// Allow large video uploads (up to 500MB)
export const maxDuration = 300; // 5 min timeout for large uploads

const MAX_IMAGE_SIZE = 50 * 1024 * 1024;   // 50MB
const MAX_VIDEO_SIZE = 500 * 1024 * 1024;  // 500MB
const MAX_FILE_SIZE = MAX_VIDEO_SIZE;
const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
];

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id as string;

  // Prefer org ID from header (set by client), fall back to first membership
  const headerOrgId = req.headers.get("x-organization-id");

  let membership;
  if (headerOrgId) {
    membership = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId: headerOrgId } },
      select: { organizationId: true },
    });
  }
  if (!membership) {
    membership = await prisma.organizationMember.findFirst({
      where: { userId },
      select: { organizationId: true },
    });
  }

  if (!membership) {
    return NextResponse.json({ error: "No organization found" }, { status: 403 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const category = (formData.get("category") as string | null) ?? "general";

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: `File type '${file.type}' is not allowed` },
      { status: 400 }
    );
  }

  const isVideo = file.type.startsWith("video/");
  const sizeLimit = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
  if (file.size > sizeLimit) {
    return NextResponse.json(
      { error: `File too large. ${isVideo ? "Videos" : "Images"} must be under ${isVideo ? "500" : "50"}MB.` },
      { status: 400 }
    );
  }

  const ext = file.name.split(".").pop() || "bin";
  const orgId = membership.organizationId;
  const key = `${orgId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const buffer = Buffer.from(await file.arrayBuffer());

  const BUCKET = process.env.S3_BUCKET || "postautomation-media";

  const s3 = new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
    },
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: file.type,
      ContentLength: buffer.length,
    })
  );

  const publicUrl = process.env.S3_PUBLIC_URL
    ? `${process.env.S3_PUBLIC_URL}/${key}`
    : `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${BUCKET}/${key}`;

  const media = await prisma.media.create({
    data: {
      organizationId: membership.organizationId,
      uploadedById: userId,
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      url: publicUrl,
      ...(category !== "general" ? { category } : {}),
    },
  });

  return NextResponse.json({
    id: media.id,
    url: publicUrl,
    fileName: file.name,
    fileType: file.type,
  });
}
