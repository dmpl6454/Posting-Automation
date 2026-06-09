/**
 * Regression guard for the Super Agent `generate_news_image` storage fix (N2).
 *
 * Bug: the action built a `data:<mime>;base64,...` URL and wrote that multi-MB
 * blob into Media.url (and returned it as imageUrl). Consequences:
 *   1. Social providers `fetch(media.url)` expecting an HTTP(S) URL → publish fails.
 *   2. A multi-MB base64 string is stored in a Postgres text column per generation.
 *
 * Fix: upload the image bytes to S3 and store the resulting S3 PUBLIC URL in
 * Media.url, returning that URL as imageUrl — same pattern as repurpose.router.
 *
 * This exercises `storeGeneratedNewsImage` (the storage seam the case calls)
 * against a mocked Prisma and a mocked S3 client, asserting the persisted URL is
 * an https S3 URL and NOT a data: URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the PutObjectCommand input + count sends.
const s3Send = vi.fn(async (_cmd?: any) => ({}));
const putInputs: any[] = [];

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: (a: any) => s3Send(a) })),
  PutObjectCommand: vi.fn().mockImplementation((input: any) => {
    putInputs.push(input);
    return { __type: "PutObjectCommand", input };
  }),
}));

import { storeGeneratedNewsImage } from "../routers/chat.router";

const S3_PUBLIC = "https://media.postautomation.co.in/postautomation-media";

const ENV_KEYS = ["S3_PUBLIC_URL", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT"];
const saved: Record<string, string | undefined> = {};

function mockPrisma() {
  const create = vi.fn(async ({ data }: any) => ({ id: "media-123", ...data }));
  return { prisma: { media: { create } } as any, create };
}

describe("storeGeneratedNewsImage (generate_news_image stores S3 URL, not data URL)", () => {
  beforeEach(() => {
    ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; });
    process.env.S3_PUBLIC_URL = S3_PUBLIC;
    process.env.S3_BUCKET = "postautomation-media";
    process.env.S3_ACCESS_KEY_ID = "minioadmin";
    process.env.S3_SECRET_ACCESS_KEY = "minioadmin";
    s3Send.mockClear();
    putInputs.length = 0;
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });

  it("uploads the bytes to S3 and writes the S3 public URL to Media.url", async () => {
    const { prisma, create } = mockPrisma();
    // a tiny 1x1 PNG, base64
    const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

    const result = await storeGeneratedNewsImage(prisma, {
      organizationId: "org-1",
      uploadedById: "user-1",
      imageBase64,
      mimeType: "image/png",
      width: 1080,
      height: 1350,
    });

    // S3 upload happened with the decoded bytes
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(putInputs).toHaveLength(1);
    expect(putInputs[0].Bucket).toBe("postautomation-media");
    expect(Buffer.isBuffer(putInputs[0].Body)).toBe(true);
    expect(putInputs[0].ContentType).toBe("image/png");

    // The URL written to Media.url is the S3 public URL, NOT a data: URL
    expect(create).toHaveBeenCalledTimes(1);
    const persistedUrl = create.mock.calls[0]![0].data.url as string;
    expect(persistedUrl.startsWith(S3_PUBLIC)).toBe(true);
    expect(persistedUrl.startsWith("data:")).toBe(false);

    // The returned URL matches what was persisted
    expect(result.url).toBe(persistedUrl);
    expect(result.url.startsWith(S3_PUBLIC)).toBe(true);
    expect(result.url.startsWith("data:")).toBe(false);
    expect(result.mediaId).toBe("media-123");
  });
});
