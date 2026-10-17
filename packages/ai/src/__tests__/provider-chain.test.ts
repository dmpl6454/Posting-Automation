import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildTextProviderChain } from "../utils/provider-chain";
import { getAnthropicModel, anthropicWorkspaceHeaders } from "../providers/anthropic.provider";

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
  it("without a deepseek key, an unchosen chain is openai -> anthropic", () => {
    expect(buildTextProviderChain(undefined)).toEqual(["openai", "anthropic"]);
  });

  // 2026-10-09 (owner decision): DeepSeek FIRST for every text feature, and the
  // first fallback after a provider the user explicitly picked. (2026-09-28 it
  // had been added as the LAST hop, after OpenAI and Anthropic ran out of credit.)
  it("puts deepseek first when nothing is chosen", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    expect(buildTextProviderChain(undefined)).toEqual(["deepseek", "openai", "anthropic"]);
  });
  it("tries deepseek right after an explicitly chosen provider", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    expect(buildTextProviderChain("openai")).toEqual(["openai", "deepseek", "anthropic"]);
    expect(buildTextProviderChain("anthropic")).toEqual(["anthropic", "deepseek", "openai"]);
  });
  it("never lists deepseek twice when it is the chosen provider", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    expect(buildTextProviderChain("deepseek")).toEqual(["deepseek", "openai", "anthropic"]);
  });
  it("leaves deepseek out entirely when no deepseek key is set", () => {
    // beforeEach stubs DEEPSEEK_API_KEY to "" — an unplumbed compose key arrives as "".
    expect(buildTextProviderChain("openai")).not.toContain("deepseek");
    expect(buildTextProviderChain(undefined)).not.toContain("deepseek");
  });
  it("keeps a chosen provider first, then the full fallback order", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("GOOGLE_GEMINI_API_KEY", "test-key");
    expect(buildTextProviderChain("gemini")).toEqual(["gemini", "deepseek", "openai", "anthropic"]);
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

  // Regression: @langchain/anthropic@0.3.x defaults topP to a -1 "unset"
  // sentinel and only strips it for opus-4-1/sonnet-4-5/haiku-4-5 model names.
  // claude-sonnet-4-6 leaks top_p:-1 onto the wire → Anthropic 400. We pass an
  // explicit valid topP so this never reaches the API (e.g. when the
  // openai->anthropic text-fallback hits the anthropic hop with OpenAI down).
  it("never sends the top_p=-1 sentinel for the default model", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    const model = getAnthropicModel();
    expect((model as unknown as { topP?: number }).topP).toBe(1);
    expect((model as unknown as { topP?: number }).topP).not.toBe(-1);
  });
});

// An account-level key (sk-ant-usr-…) is refused by Anthropic unless every
// request names a workspace (prod key swap, 2026-10-17).
describe("ANTHROPIC_WORKSPACE_ID", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends no header when unset, empty or malformed", () => {
    expect(anthropicWorkspaceHeaders(undefined)).toBeUndefined();
    expect(anthropicWorkspaceHeaders("")).toBeUndefined();
    expect(anthropicWorkspaceHeaders("   ")).toBeUndefined();
    expect(anthropicWorkspaceHeaders("wrkspc_1\r\nx-evil: 1")).toBeUndefined();
    expect(anthropicWorkspaceHeaders("a b")).toBeUndefined();
  });

  it("trims and accepts a Console workspace id", () => {
    expect(anthropicWorkspaceHeaders(" wrkspc_01AbC-9 ")).toEqual({ "anthropic-workspace-id": "wrkspc_01AbC-9" });
  });

  async function wireHeaders(): Promise<Headers> {
    let seen: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    await getAnthropicModel().invoke("hi");
    if (!seen) throw new Error("no request was made");
    return seen;
  }

  it("puts the header on the actual request when set", async () => {
    vi.stubEnv("ANTHROPIC_WORKSPACE_ID", "wrkspc_01AbC");
    const h = await wireHeaders();
    expect(h.get("anthropic-workspace-id")).toBe("wrkspc_01AbC");
    expect(h.get("x-api-key")).toBe("test-key");
  });

  it("leaves the request without it when unset (workspace keys)", async () => {
    vi.stubEnv("ANTHROPIC_WORKSPACE_ID", "");
    const h = await wireHeaders();
    expect(h.get("anthropic-workspace-id")).toBeNull();
    expect(h.get("x-api-key")).toBe("test-key");
  });
});
