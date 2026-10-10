import { describe, it, expect } from "vitest";
import { toLocalDateTimeInput, nowLocalDateTimeInput } from "./local-datetime";
import { readSourceWithoutComments } from "./source-lock";

/**
 * The DateTimePicker reads/writes a LOCAL "YYYY-MM-DDTHH:mm". Seeding it from
 * a UTC slice shifted every schedule by the timezone offset (2026-10-10).
 */
describe("toLocalDateTimeInput", () => {
  it("formats the LOCAL clock face, round-tripping through the picker's own parse", () => {
    const d = new Date(2026, 9, 10, 18, 30); // 10 Oct 2026, 18:30 local — whatever TZ the test runs in
    expect(toLocalDateTimeInput(d)).toBe("2026-10-10T18:30");
    expect(new Date(toLocalDateTimeInput(d)).getTime()).toBe(d.getTime());
    // ISO strings (what tRPC hands the page) are converted through the same local clock.
    expect(toLocalDateTimeInput(d.toISOString())).toBe("2026-10-10T18:30");
  });

  it("disagrees with the UTC slice by exactly the timezone offset (the old bug)", () => {
    const d = new Date(2026, 9, 10, 18, 30);
    const utcSlice = d.toISOString().slice(0, 16);
    const offsetMin = d.getTimezoneOffset();
    if (offsetMin === 0) {
      expect(toLocalDateTimeInput(d)).toBe(utcSlice);
    } else {
      expect(toLocalDateTimeInput(d)).not.toBe(utcSlice);
      expect((d.getTime() - new Date(utcSlice).getTime()) / 60_000).toBe(-offsetMin);
    }
  });

  it("returns '' for nothing / an invalid date", () => {
    expect(toLocalDateTimeInput(null)).toBe("");
    expect(toLocalDateTimeInput(undefined)).toBe("");
    expect(toLocalDateTimeInput("")).toBe("");
    expect(toLocalDateTimeInput("not a date")).toBe("");
  });

  it("nowLocalDateTimeInput is the same format for the current minute", () => {
    const now = new Date(2026, 0, 5, 9, 7);
    expect(nowLocalDateTimeInput(now)).toBe("2026-01-05T09:07");
  });
});

describe("no DateTimePicker is fed a UTC slice (source lock)", () => {
  const files = [
    "apps/web/components/content-agent/ComposeTab.tsx",
    "apps/web/components/content-agent/BulkTab.tsx",
    "apps/web/app/dashboard/posts/[id]/page.tsx",
    "apps/web/app/dashboard/settings/api-keys/page.tsx",
    "apps/web/app/dashboard/newsgrid/page.tsx",
  ];
  for (const f of files) {
    it(f, () => {
      const src = readSourceWithoutComments(f);
      expect(src).not.toMatch(/toISOString\(\)\.slice\(0,\s*16\)/);
    });
  }

  it("the post page seeds its schedule picker from the local formatter", () => {
    const src = readSourceWithoutComments("apps/web/app/dashboard/posts/[id]/page.tsx");
    expect(src).toMatch(/setScheduledAt\(toLocalDateTimeInput\(post\.scheduledAt\)\)/);
  });
});
