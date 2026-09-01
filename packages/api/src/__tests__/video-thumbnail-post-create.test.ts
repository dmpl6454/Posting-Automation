import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Server-side contract for the user-uploaded video cover.
 *
 * Asserted at the SOURCE level (house pattern — see analytics-platform-filter.test.ts):
 * post.create is a long mutation whose behaviour here is a sequence of guards, and
 * the thing that must not regress is that each guard EXISTS and runs before the
 * value is trusted. A mocked-Prisma call would exercise one happy path and miss a
 * removed guard entirely.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const src = readFileSync(join(ROOT, "packages/api/src/routers/post.router.ts"), "utf8");

describe("post.create accepts only a mediaId for the video thumbnail", () => {
  it("does NOT accept a client-supplied url in the zod input", () => {
    // ⚠️ The URL is handed to Meta/Google to FETCH. Accepting one from the client
    // is an SSRF/exfil vector, and Instagram interpolates it into a container that
    // fails the WHOLE publish when malformed.
    expect(src).toMatch(/videoThumbnail: z\.object\(\{ mediaId: z\.string\(\)\.min\(1\) \}\)\.optional\(\)/);
  });

  it("org-scopes the mediaId with assertMediaOwned before using it", () => {
    // A foreign mediaId must never become a URL we hand to a platform.
    expect(src).toMatch(/assertMediaOwned\(ctx\.prisma, ctx\.organizationId, \[thumbMediaId\]\)/);
  });

  it("resolves the public URL from the DB, not from input", () => {
    expect(src).toMatch(/videoThumbnail = \{ mediaId: thumbMediaId, url: thumbRow\.url \}/);
  });

  it("rejects a non-image thumbnail", () => {
    expect(src).toMatch(/thumbRow\.fileType\?\.startsWith\("image\/"\)/);
  });

  it("rejects a thumbnail that is not publicly reachable", () => {
    // A localhost/MinIO-internal URL would fail only at Meta's fetch, surfacing as
    // an opaque container ERROR minutes later instead of an actionable message.
    expect(src).toMatch(/thumbnail is not publicly reachable/);
  });

  it("STRIPS the raw client key before writing metadata", () => {
    // The stored value must be the server-resolved reference, never the client's.
    expect(src).toMatch(/videoThumbnail: _rawThumb/);
    expect(src).toMatch(/if \(videoThumbnail\) out\.videoThumbnail = videoThumbnail;/);
  });

  it("writes nothing when no thumbnail was chosen — byte-identical path", () => {
    // `videoThumbnail` stays null, so `out` gains no key and the metadata write is
    // exactly the pre-feature one.
    expect(src).toMatch(/let videoThumbnail: \{ mediaId: string; url: string \} \| null = null/);
  });
});
