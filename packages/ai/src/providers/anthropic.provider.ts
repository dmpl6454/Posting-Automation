import { ChatAnthropic } from "@langchain/anthropic";
import { aiFailedAttemptHandler } from "../utils/credit-exhaustion";

// Default to claude-sonnet-4-6 (current, non-deprecated alias — no date suffix).
// Operators can override via ANTHROPIC_MODEL without a code change if Anthropic
// rotates model IDs again. (Mirrors the OPENAI_MODEL override in openai.provider.ts.)
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

// A workspace id as the Console shows it (e.g. "wrkspc_01AbC…"). Anything else
// — including "" from an unplumbed compose key — sends NO header, which is the
// pre-2026-10-17 request byte-for-byte.
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Headers for an Anthropic key that is NOT scoped to a workspace (account-level
 * keys, prefix `sk-ant-usr-`). Anthropic refuses those with HTTP 400 "This API
 * key is not scoped to a workspace, so this request must include the
 * anthropic-workspace-id header" (2026-10-17, prod key swap). Workspace keys
 * (`sk-ant-api03-`) need nothing, so leave ANTHROPIC_WORKSPACE_ID unset for them.
 */
export function anthropicWorkspaceHeaders(
  raw: string | undefined = process.env.ANTHROPIC_WORKSPACE_ID
): Record<string, string> | undefined {
  const id = raw?.trim();
  if (!id || !WORKSPACE_ID_RE.test(id)) return undefined;
  return { "anthropic-workspace-id": id };
}

export function getAnthropicModel(temperature = 0.7) {
  const workspaceHeaders = anthropicWorkspaceHeaders();
  return new ChatAnthropic({
    modelName: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    temperature,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    // ⚠️ @langchain/anthropic@0.3.34 uses topP=-1 as an internal "unset"
    // sentinel and only strips it for model names containing opus-4-1 /
    // sonnet-4-5 / haiku-4-5. claude-sonnet-4-6 matches NONE of those, so the
    // ctor's else-branch (`this.topP = fields?.topP ?? this.topP` = -1) leaks a
    // literal top_p:-1 onto the wire → Anthropic 400 "top_p cannot be set to -1
    // for this model". This surfaces whenever the [chosen→openai→anthropic]
    // text-fallback chain reaches the anthropic hop (e.g. OpenAI out of credits).
    // Pass an explicit valid value (matches ChatOpenAI's own topP default of 1).
    // topP: undefined / null do NOT work — both collapse back to -1 via `?? -1`.
    topP: 1,
    onFailedAttempt: aiFailedAttemptHandler,
    // Spread only when set, so a workspace-scoped key keeps the exact old ctor args.
    ...(workspaceHeaders ? { clientOptions: { defaultHeaders: workspaceHeaders } } : {}),
  });
}
