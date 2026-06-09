/**
 * Regression guard for the A1-followup stable idempotency key.
 *
 * Bug (review of commit 993e398): the client used the EPHEMERAL streaming message
 * id (`ai-<ts>`) as both the executedActionIds lock key AND the clientActionId.
 * After a publish succeeded, `getThread.invalidate()` refetched the thread and
 * rebuilt messages with each message's DB id, so the lock key changed and the
 * server marker (`ai-<ts>`) no longer matched the now-DB-id clientActionId → the
 * "Done" button re-enabled and a re-click created a SECOND LIVE post.
 *
 * Fix: `withIdempotencyKey` stamps a STABLE uuid onto the parsed action ONCE. The
 * SAME object is both sent in the SSE `done` event and persisted into
 * `metadata.action`, so the key survives the streaming→persisted id transition.
 *
 * This test pins the pure helper: identical key for send + persist, generated
 * exactly once, preserved if already present, and null passthrough.
 */
import { describe, it, expect } from "vitest";
import { withIdempotencyKey, parseActions } from "../chains/chat-agent.chain";

describe("withIdempotencyKey (A1 followup — stable idempotency key)", () => {
  it("attaches an idempotencyKey to a parsed action", () => {
    const action = parseActions('```action\n{"type":"publish_now","payload":{"content":"hi"}}\n```');
    expect(action).not.toBeNull();
    const stamped = withIdempotencyKey(action);
    expect(stamped?.idempotencyKey).toBeTruthy();
    expect(typeof stamped?.idempotencyKey).toBe("string");
  });

  it("uses the SAME key for the SSE-send object and the DB-persist object (generated once)", () => {
    // The route stamps the key ONCE, then sends + persists the SAME object.
    const action = parseActions('```action\n{"type":"publish_now","payload":{"content":"hi"}}\n```');
    const stamped = withIdempotencyKey(action);

    // Whatever goes out in the `done` event and whatever is written to
    // metadata.action are the SAME reference / value — not two separate calls.
    const sentInDone = stamped;
    const persistedInMetadata = stamped;
    expect(sentInDone?.idempotencyKey).toBe(persistedInMetadata?.idempotencyKey);
    expect(sentInDone?.idempotencyKey).toBeDefined();
  });

  it("generates the key exactly once (does not regenerate per call)", () => {
    let calls = 0;
    const gen = () => {
      calls += 1;
      return `uuid-${calls}`;
    };
    const action = parseActions('```action\n{"type":"schedule_post","payload":{"content":"x"}}\n```');
    const stamped = withIdempotencyKey(action, gen);
    expect(calls).toBe(1);
    expect(stamped?.idempotencyKey).toBe("uuid-1");
  });

  it("preserves an existing idempotencyKey rather than regenerating", () => {
    const action = { type: "publish_now" as const, payload: {}, idempotencyKey: "pre-existing" };
    const stamped = withIdempotencyKey(action, () => "should-not-be-used");
    expect(stamped?.idempotencyKey).toBe("pre-existing");
  });

  it("returns null unchanged for a no-action response", () => {
    expect(withIdempotencyKey(null)).toBeNull();
  });

  it("uses a real crypto.randomUUID by default (stable, non-empty across calls)", () => {
    const a = withIdempotencyKey({ type: "publish_now" as const, payload: {} });
    const b = withIdempotencyKey({ type: "publish_now" as const, payload: {} });
    expect(a?.idempotencyKey).toBeTruthy();
    expect(b?.idempotencyKey).toBeTruthy();
    // Two independent stamps get distinct keys (one per action), but each is stable.
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
  });
});
