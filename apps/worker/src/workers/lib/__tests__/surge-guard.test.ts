import { describe, it, expect } from "vitest";
import { hasSurgeBaseline } from "../surge-guard";

const HOUR = 60 * 60 * 1000;
describe("hasSurgeBaseline", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  it("false for a query created 1 minute ago (no baseline yet)", () => {
    expect(hasSurgeBaseline(new Date(now.getTime() - 60 * 1000), now)).toBe(false);
  });
  it("false for a query created 30h ago (< 48h window incomplete)", () => {
    expect(hasSurgeBaseline(new Date(now.getTime() - 30 * HOUR), now)).toBe(false);
  });
  it("true for a query created 3 days ago (full baseline)", () => {
    expect(hasSurgeBaseline(new Date(now.getTime() - 72 * HOUR), now)).toBe(true);
  });
  it("true exactly at the 48h boundary", () => {
    expect(hasSurgeBaseline(new Date(now.getTime() - 48 * HOUR), now)).toBe(true);
  });
});
