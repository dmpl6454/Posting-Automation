import { describe, it, expect } from "vitest";
import { readSourceWithoutComments } from "./source-lock";

/**
 * Super Agent provider order (owner decision 2026-10-09): Anthropic answers
 * first, DeepSeek if Anthropic fails. Locked at the source of the streaming
 * route, which picks the provider and walks the fallback list itself.
 */
const src = readSourceWithoutComments("apps/web/app/api/chat/stream/route.ts");

describe("Super Agent provider order", () => {
  it("starts with Anthropic unless the request names a provider", () => {
    expect(src).toMatch(/const provider: AIProvider = body\.provider \?\? "anthropic";/);
    // The smart router / agent preference could put any provider first.
    expect(src).not.toMatch(/routeProvider\(/);
    expect(src).not.toMatch(/thread\.agent\?\.aiProvider/);
  });

  it("falls back to DeepSeek right after Anthropic for text", () => {
    expect(src).toContain(': ["anthropic", "deepseek", "openai", "grok", "gemini", "gemma4"]');
  });

  it("keeps an image turn on vision-capable providers (DeepSeek cannot read images)", () => {
    expect(src).toContain('? ["anthropic", "gemini", "openai"]');
  });
});
