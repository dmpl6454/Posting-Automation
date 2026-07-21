import { describe, it, expect, beforeAll } from "vitest";
import { UploadPartCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3PresignClient, getS3Client } from "../lib/s3";

/**
 * Regression guard for the presigned-URL checksum pinning bug.
 *
 * AWS SDK ≥3.729 defaults requestChecksumCalculation to "WHEN_SUPPORTED",
 * which computes a CRC32 over the (empty!) server-side command body and bakes
 * `x-amz-checksum-crc32=AAAAAA==` + `x-amz-sdk-checksum-algorithm=CRC32` into
 * the SIGNED query of presigned UploadPart/PutObject URLs. The browser then
 * PUTs an 8MB part against a URL that pins the empty-body checksum. Observed
 * live on prod nginx logs 2026-07-21. MinIO ignores the pinned value today;
 * AWS S3 (and future MinIO) reject every such part with BadDigest — which
 * would silently kill ALL multipart (video) uploads. lib/s3.ts therefore sets
 * requestChecksumCalculation: "WHEN_REQUIRED" on both clients; this test
 * fails if anyone removes it.
 */

beforeAll(() => {
  process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "test-key";
  process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || "test-secret";
  process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
});

describe("presigned upload URLs", () => {
  it("UploadPart presign does not pin an empty-body checksum into the query", async () => {
    const url = await getSignedUrl(
      getS3PresignClient(),
      new UploadPartCommand({ Bucket: "b", Key: "org/file.mp4", UploadId: "u1", PartNumber: 1 }),
      { expiresIn: 3600 }
    );
    expect(url).not.toMatch(/x-amz-checksum/i);
    expect(url).not.toMatch(/x-amz-sdk-checksum/i);
  });

  it("PutObject presign (single-shot path) is clean too", async () => {
    const url = await getSignedUrl(
      getS3Client(),
      new PutObjectCommand({ Bucket: "b", Key: "org/file.png", ContentType: "image/png" }),
      { expiresIn: 3600 }
    );
    expect(url).not.toMatch(/x-amz-checksum/i);
    expect(url).not.toMatch(/x-amz-sdk-checksum/i);
  });
});
