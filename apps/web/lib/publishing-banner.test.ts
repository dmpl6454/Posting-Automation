import { describe, expect, it } from "vitest";
import { publishingBannerText, formatLate } from "./publishing-banner";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("publishingBannerText", () => {
  it("shows nothing when ok, unknown, or no answer", () => {
    expect(publishingBannerText({ status: "ok" })).toBeNull();
    expect(publishingBannerText({ status: "unknown" })).toBeNull();
    expect(publishingBannerText(null)).toBeNull();
  });

  it("down tells users their posts are safe", () => {
    expect(publishingBannerText({ status: "down" })).toMatch(/paused.*safe/);
  });

  it("delayed says how late", () => {
    expect(publishingBannerText({ status: "delayed", oldestOverdueMinutes: 125 })).toContain("up to 2 hours late");
    expect(publishingBannerText({ status: "delayed", oldestOverdueMinutes: 14 })).toContain("up to 14 min late");
  });

  it("formatLate", () => {
    expect(formatLate(59)).toBe("59 min");
    expect(formatLate(61)).toBe("1 hour");
  });

  it("the dashboard shell renders the banner", () => {
    const src = readFileSync(path.join(__dirname, "../components/layout/dashboard-shell.tsx"), "utf8");
    expect(src).toContain("<PublishingStatusBanner />");
  });
});
