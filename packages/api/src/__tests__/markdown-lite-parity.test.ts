/**
 * markdown-lite exists twice: the canonical copy in @postautomation/social (the
 * publish worker renders a WordPress article body with it) and a replica in
 * apps/web/lib (Compose's article preview). If they differ, the preview lies
 * about what the site receives. This test lives in api because it can read
 * both files; it demands BYTE identity so there is nothing to reason about.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

describe("markdown-lite replica", () => {
  it("apps/web/lib/markdown-lite.ts is byte-identical to the canonical social copy", () => {
    const canonical = readFileSync(join(ROOT, "packages/social/src/utils/markdown-lite.ts"), "utf8");
    const replica = readFileSync(join(ROOT, "apps/web/lib/markdown-lite.ts"), "utf8");
    expect(replica).toBe(canonical);
  });
});
