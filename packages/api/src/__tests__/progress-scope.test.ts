import { describe, it, expect } from "vitest";
import { scopedProgressId } from "../lib/progress";

/**
 * Regression test for the cross-tenant IDOR fix on the progress SSE stream.
 * The client-supplied repurpose id is low-entropy (`rep-<ts>-<6char>`), so the
 * Redis keys/channels are namespaced by the authenticated userId. The reader
 * (apps/web/app/api/progress/route.ts) MUST derive the identical scoped id.
 */
describe("scopedProgressId", () => {
  it("prefixes the id with the userId and a colon", () => {
    expect(scopedProgressId("u1", "rep-x")).toBe("u1:rep-x");
  });

  it("produces the same key for the same (userId, id) pair", () => {
    expect(scopedProgressId("u1", "rep-123-abcdef")).toBe(
      scopedProgressId("u1", "rep-123-abcdef"),
    );
  });

  it("produces DIFFERENT keys for different users with the same id (IDOR isolation)", () => {
    const id = "rep-1717000000000-a1b2c3";
    const a = scopedProgressId("userA", id);
    const b = scopedProgressId("userB", id);
    expect(a).not.toBe(b);
    expect(a).toBe(`userA:${id}`);
    expect(b).toBe(`userB:${id}`);
  });

  it("matches the reader-side key construction used in route.ts", () => {
    const userId = "user-xyz";
    const id = "rep-1717000000000-zzz999";
    // Reader inlines `${session.user.id}:${id}` for `rep-` ids — keep in sync.
    const readerKey = `${userId}:${id}`;
    expect(scopedProgressId(userId, id)).toBe(readerKey);
  });
});
