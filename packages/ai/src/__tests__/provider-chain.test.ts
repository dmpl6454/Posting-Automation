import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildTextProviderChain } from "../utils/provider-chain";
import { getAnthropicModel } from "../providers/anthropic.provider";

describe("buildTextProviderChain", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("GOOGLE_GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_AI_API_KEY", "");
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("falls back openai -> anthropic when chosen is openai", () => {
    expect(buildTextProviderChain("openai")).toEqual(["openai", "anthropic"]);
  });
  it("defaults to openai when chosen is undefined", () => {
    expect(buildTextProviderChain(undefined)).toEqual(["openai", "anthropic"]);
  });
});

describe("getAnthropicModel default model id", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses a date-suffix-free claude model id by default", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    const model = getAnthropicModel();
    const modelName =
      (model as unknown as { modelName?: string; model?: string }).modelName ??
      (model as unknown as { model?: string }).model;
    expect(modelName).toBe("claude-sonnet-4-6");
    expect(modelName).not.toMatch(/-\d{8}$/);
  });
  it("honors the ANTHROPIC_MODEL env override", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-4-6");
    const model = getAnthropicModel();
    const modelName =
      (model as unknown as { modelName?: string; model?: string }).modelName ??
      (model as unknown as { model?: string }).model;
    expect(modelName).toBe("claude-opus-4-6");
  });
});
