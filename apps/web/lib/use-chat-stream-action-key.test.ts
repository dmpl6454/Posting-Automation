import { describe, expect, it } from "vitest";
import { actionKey } from "./chat-action-key";

/**
 * A1 idempotency: actionKey is the stable key used for BOTH the client-side
 * executed lock (executedActionIds Set in useChatStream) AND the clientActionId
 * sent to the server (isActionAlreadyExecuted dedupes on threadId+clientActionId
 * for publish_now/schedule_post/bulk_schedule).
 *
 * Imported from apps/web/lib/chat-action-key.ts — a pure module with no React
 * deps so it can be tested in the vitest node environment.
 *
 * The logic is a single expression:
 *
 *   export function actionKey(msgId: string, idempotencyKey?: string): string {
 *     return idempotencyKey ?? msgId;
 *   }
 */

describe("actionKey (A1 idempotency)", () => {
  it("returns idempotencyKey when present — stable UUID wins over ephemeral msgId", () => {
    expect(actionKey("msg-123", "idem-uuid-abc")).toBe("idem-uuid-abc");
  });

  it("falls back to msgId when idempotencyKey is undefined — legacy messages still locked", () => {
    expect(actionKey("msg-123", undefined)).toBe("msg-123");
  });

  it("uses empty string as-is (server never sends empty; ?? not ||)", () => {
    // actionKey uses ?? so only null/undefined trigger the fallback.
    // This documents the precise semantics — the server always stamps a real UUID.
    expect(actionKey("msg-123", "")).toBe("");
  });

  it("two calls with the same inputs produce the same key (deterministic / no random)", () => {
    expect(actionKey("msg-xyz", "idem-999")).toBe(actionKey("msg-xyz", "idem-999"));
  });

  it("different messages produce different keys (no cross-contamination)", () => {
    const k1 = actionKey("msg-1", "idem-aaa");
    const k2 = actionKey("msg-2", "idem-bbb");
    expect(k1).not.toBe(k2);
  });

  it("idempotencyKey is preferred even when msgId and key differ — refetch safety", () => {
    // The message id is ephemeral (changes between optimistic and persisted);
    // the idempotencyKey is server-stamped and stable across refetches.
    // Preference for idempotencyKey is what makes the lock survive a getThread refetch.
    const stableKey = "stable-server-uuid";
    expect(actionKey("ephemeral-temp-id", stableKey)).toBe(stableKey);
    expect(actionKey("persisted-db-id", stableKey)).toBe(stableKey);
  });

  it("the key derived here matches the clientActionId logic: actionKey(msgId, action.idempotencyKey)", () => {
    // Simulates the executeAction path in use-chat-stream.ts:
    //   const key = actionKey(msgId, action.idempotencyKey)
    //   await executeActionMutation.mutateAsync({ ..., clientActionId: key })
    // The clientActionId sent to the server must equal the key stored in executedActionIds.
    const msgId = "db-msg-id-abc";
    const action = { type: "schedule_post", payload: {}, idempotencyKey: "idem-server-uuid-xyz" };
    const key = actionKey(msgId, action.idempotencyKey);
    expect(key).toBe("idem-server-uuid-xyz"); // clientActionId sent to server
    // The server stores this as metadata.executedActionId; on refetch the seeding
    // loop adds it to executedActionIds; and the button checks executedActionIds.has(key).
    // All three sides use the SAME key expression — this test locks that contract.
  });
});
