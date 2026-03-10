import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * Shared S3/MinIO client configuration.
 * Uses env vars: S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_URL
 */

export function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true, // Required for MinIO
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    },
  });
}

export const BUCKET = process.env.S3_BUCKET || "postautomation-media";

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
