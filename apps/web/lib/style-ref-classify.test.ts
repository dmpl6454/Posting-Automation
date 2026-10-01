import { describe, it, expect } from "vitest";
import { shouldClassifyStyleRefOnBlur } from "./style-ref-classify";
import { readSourceWithoutComments } from "./source-lock";

describe("shouldClassifyStyleRefOnBlur", () => {
  it("classifies a newly committed http(s) URL", () => {
    expect(shouldClassifyStyleRefOnBlur("https://example.com/a.png", null)).toBe(true);
    expect(shouldClassifyStyleRefOnBlur("HTTP://example.com/a.png", "https://other.com/b.png")).toBe(true);
  });

  it("skips a URL that was already classified (re-blur of an unchanged field)", () => {
    expect(shouldClassifyStyleRefOnBlur("https://example.com/a.png", "https://example.com/a.png")).toBe(false);
  });

  it("compares the trimmed value", () => {
    expect(shouldClassifyStyleRefOnBlur("  https://example.com/a.png  ", "https://example.com/a.png")).toBe(false);
  });

  it("skips anything that does not look like a URL", () => {
    expect(shouldClassifyStyleRefOnBlur("", null)).toBe(false);
    expect(shouldClassifyStyleRefOnBlur("not a url", null)).toBe(false);
    expect(shouldClassifyStyleRefOnBlur("ftp://example.com/a.png", null)).toBe(false);
  });
});

/**
 * RepurposeTab has no component harness, so the wiring is locked at the source
 * level. classifyStyleReference is fail-soft by contract (a miss must never pop
 * a toast); without a hook-level onError, the global MutationCache handler would
 * toast its 429 / FORBIDDEN.
 */
const src = readSourceWithoutComments("apps/web/components/content-agent/RepurposeTab.tsx");

describe("RepurposeTab classifyStyleReference wiring", () => {
  it("declares a no-op hook-level onError so the global handler never toasts it", () => {
    expect(src).toMatch(
      /trpc\.repurpose\.classifyStyleReference\.useMutation\(\s*\{\s*onError:\s*\(\)\s*=>\s*\{\s*\}\s*,?\s*\}\s*\)/,
    );
  });

  it("records the last classified URL and skips an unchanged one on blur", () => {
    expect(src).toMatch(/lastClassifiedRefUrlRef\.current = refUrl/);
    expect(src).toMatch(/shouldClassifyStyleRefOnBlur\(\s*e\.target\.value,\s*lastClassifiedRefUrlRef\.current\s*\)/);
  });
});
