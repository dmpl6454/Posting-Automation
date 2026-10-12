import { describe, it, expect } from "vitest";
import { scheduleTimeProblem, defaultTimeForDate, toLocalDateTimeInput } from "./local-datetime";
import { readSourceWithoutComments } from "./source-lock";

/**
 * Owner report 2026-10-12: "the Schedule button is greyed". It was DISABLED
 * until a time was picked in a separate box, with no visible reason. It now
 * stays clickable; a click with no (or a past) time explains and opens the
 * picker.
 */
describe("scheduleTimeProblem", () => {
  const now = new Date(2026, 9, 12, 22, 30).getTime();
  it("names a missing time", () => {
    expect(scheduleTimeProblem("", now)).toMatch(/Pick a date and time/);
    expect(scheduleTimeProblem("garbage", now)).toMatch(/Pick a date and time/);
  });
  it("names a past time, with the server's 60s skew allowance", () => {
    expect(scheduleTimeProblem(toLocalDateTimeInput(new Date(now - 5 * 60_000)), now)).toMatch(/already passed/);
    expect(scheduleTimeProblem(toLocalDateTimeInput(new Date(now)), now)).toBeNull();
    expect(scheduleTimeProblem(toLocalDateTimeInput(new Date(now + 3_600_000)), now)).toBeNull();
  });
});

describe("defaultTimeForDate", () => {
  it("picks the next full hour today", () => {
    const now = new Date(2026, 9, 12, 14, 20);
    const d = defaultTimeForDate(new Date(2026, 9, 12), now);
    expect([d.date.getDate(), d.hour, d.minute]).toEqual([12, 15, 0]);
  });
  it("rolls into tomorrow after 23:00 instead of today 00:00 (in the past)", () => {
    const now = new Date(2026, 9, 12, 23, 10);
    const d = defaultTimeForDate(new Date(2026, 9, 12), now);
    expect([d.date.getDate(), d.hour]).toEqual([13, 0]);
    expect(new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), d.hour).getTime()).toBeGreaterThan(now.getTime());
  });
  it("keeps the old next-hour default on another day", () => {
    const now = new Date(2026, 9, 12, 14, 20);
    const d = defaultTimeForDate(new Date(2026, 9, 20), now);
    expect([d.date.getDate(), d.hour]).toEqual([20, 15]);
  });
});

describe("Compose Schedule button (source lock)", () => {
  const src = readSourceWithoutComments("apps/web/components/content-agent/ComposeTab.tsx");
  it("is no longer disabled just because no time is set", () => {
    const btn = src.slice(src.indexOf('onClick={() => handleSubmit(false)}'), src.indexOf('"Schedule"}'));
    expect(btn).not.toMatch(/!scheduledAt/);
  });
  it("a click with no usable time explains and opens the picker", () => {
    expect(src).toMatch(/const problem = scheduleTimeProblem\(scheduledAt\);/);
    expect(src).toMatch(/setSchedulePickerOpen\(true\)/);
    expect(src).toMatch(/open=\{schedulePickerOpen\}/);
  });
});
