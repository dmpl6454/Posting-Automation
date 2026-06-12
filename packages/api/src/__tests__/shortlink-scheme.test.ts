import { describe, it, expect } from "vitest";
import { z } from "zod";

const schema = z.string().url().refine(
  (u) => { try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; } },
  { message: "Only http(s) URLs are allowed" }
);

describe("shortlink url scheme", () => {
  it("accepts https", () => { expect(schema.safeParse("https://example.com").success).toBe(true); });
  it("accepts http", () => { expect(schema.safeParse("http://example.com").success).toBe(true); });
  it("rejects javascript:", () => { expect(schema.safeParse("javascript:alert(1)").success).toBe(false); });
  it("rejects data:", () => { expect(schema.safeParse("data:text/html,<script>x</script>").success).toBe(false); });
  it("rejects vbscript:", () => { expect(schema.safeParse("vbscript:msgbox(1)").success).toBe(false); });
  it("rejects file:", () => { expect(schema.safeParse("file:///etc/passwd").success).toBe(false); });
});
