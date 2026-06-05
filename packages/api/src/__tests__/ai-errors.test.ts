/**
 * Guards that AI-provider errors are mapped to clean, user-facing messages and
 * never leak raw provider internals (Google project IDs, JSON status blobs).
 */
import { describe, it, expect } from "vitest";
import {
  isMissingAIKeyError,
  isProviderBillingError,
  friendlyAIMessage,
  toFriendlyAIError,
} from "../lib/ai-errors";

const DUNNING_403 =
  'Nano Banana API error (403): { "error": { "code": 403, "message": "Lightning dunning decision is deny for project: projects/518560861182", "status": "PERMISSION_DENIED" } }';

describe("ai-errors", () => {
  it("detects the Google billing/dunning 403 as a billing error", () => {
    expect(isProviderBillingError(new Error(DUNNING_403))).toBe(true);
    expect(isProviderBillingError(new Error("insufficient_quota"))).toBe(true);
    expect(isProviderBillingError(new Error("just a normal error"))).toBe(false);
  });

  it("still detects missing-key errors", () => {
    expect(isMissingAIKeyError(new Error("OPENAI_API_KEY environment variable is required"))).toBe(true);
    expect(isMissingAIKeyError(new Error("FAL_KEY is required for AI video generation"))).toBe(true);
  });

  it("friendlyAIMessage never leaks the project ID or JSON status", () => {
    const msg = friendlyAIMessage(new Error(DUNNING_403));
    expect(msg).not.toContain("518560861182");
    expect(msg).not.toContain("PERMISSION_DENIED");
    expect(msg).not.toContain("projects/");
    expect(msg.toLowerCase()).toContain("temporarily unavailable");
  });

  it("friendlyAIMessage strips leaked project IDs even for unclassified errors", () => {
    const msg = friendlyAIMessage(new Error('boom for projects/123456 { "status": "X" }'));
    expect(msg).not.toContain("projects/123456");
  });

  it("friendlyAIMessage passes through a plain, safe message", () => {
    expect(friendlyAIMessage(new Error("Couldn't reach the page"))).toBe("Couldn't reach the page");
  });

  it("toFriendlyAIError maps billing 403 to PRECONDITION_FAILED with a clean message", () => {
    const err = toFriendlyAIError(new Error(DUNNING_403));
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).not.toContain("518560861182");
    expect(err.message.toLowerCase()).toContain("temporarily unavailable");
  });

  it("toFriendlyAIError maps missing key to PRECONDITION_FAILED", () => {
    const err = toFriendlyAIError(new Error("OPENAI API key not found"));
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).toContain("Not Configured");
  });
});
