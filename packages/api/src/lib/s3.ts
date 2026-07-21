import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * Shared S3/MinIO client configuration.
 * Uses env vars: S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_URL
 */

/**
 * ⚠️ requestChecksumCalculation MUST stay "WHEN_REQUIRED" on both clients.
 * AWS SDK ≥3.729 defaults to "WHEN_SUPPORTED", which computes a CRC32 for
 * every command — including presigned UploadPart/PutObject commands that have
 * NO body server-side. The checksum of that empty body (x-amz-checksum-crc32=
 * AAAAAA==) gets PINNED into the signed query string, so every browser part
 * PUT claims its 8MB body has an empty-payload checksum. MinIO currently
 * ignores the query-pinned value (observed live 2026-07-21), but AWS S3 —
 * and future MinIO versions — validate it and would reject EVERY part with
 * BadDigest, silently breaking all multipart (video) uploads.
 */
const CHECKSUM_COMPAT = {
  requestChecksumCalculation: "WHEN_REQUIRED" as const,
  responseChecksumValidation: "WHEN_REQUIRED" as const,
};

export function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true, // Required for MinIO
    ...CHECKSUM_COMPAT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
    },
  });
}

/**
 * S3 client used for minting presigned URLs that will be loaded by the browser.
 * Uses S3_PRESIGN_ENDPOINT (or S3_PUBLIC_URL stripped of trailing bucket path)
 * so the signed URL host is reachable from the user's browser, not just the
 * Docker network. Falls back to the internal endpoint for dev.
 */
export function getS3PresignClient(): S3Client {
  const presignEndpoint = process.env.S3_PRESIGN_ENDPOINT
    ?? process.env.S3_PUBLIC_URL?.replace(/\/[^/]+$/, "")  // strip trailing /<bucket>
    ?? process.env.S3_ENDPOINT;

  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: presignEndpoint,
    forcePathStyle: true,
    ...CHECKSUM_COMPAT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
    },
  });
}

export const BUCKET = process.env.S3_BUCKET || "postautomation-media";

/**
 * Returns true when at least one access-key var and one secret var are set.
 * The client falls back to "" otherwise, which makes uploads fail with an
 * opaque error — callers should pre-flight this and return a clear message.
 * Audit fix 2026-06-06 (#17).
 */
export function isS3Configured(): boolean {
  const key = process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "";
  const secret = process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "";
  return key.length > 0 && secret.length > 0;
}

/**
 * Build the public URL for an S3 object given its key.
 */
export function getPublicUrl(key: string): string {
  if (process.env.S3_PUBLIC_URL) {
    return `${process.env.S3_PUBLIC_URL}/${key}`;
  }
  return `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${BUCKET}/${key}`;
}

/**
 * Upload a base64-encoded file to S3 and return its public URL.
 */
export async function uploadBase64ToS3(params: {
  base64: string;
  mimeType: string;
  key: string;
}): Promise<string> {
  const { base64, mimeType, key } = params;

  const buffer = Buffer.from(base64, "base64");

  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ContentLength: buffer.length,
    })
  );

  return getPublicUrl(key);
}
