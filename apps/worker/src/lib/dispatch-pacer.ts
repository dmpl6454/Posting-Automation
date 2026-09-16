/**
 * Same-post, same-platform DISPATCH pacing (2026-09-16).
 *
 * WHY. The enqueue stagger (packages/queue publish-stagger.ts) spaces the
 * START of each target's job 10s apart for Meta. That used to also space the
 * actual publish calls, because every video target then did its own watermark
 * encode behind a FIFO semaphore. Since the per-channel watermark was removed,
 * all targets of a fan-out share ONE normalize encode: targets 1..9 arrive
 * while it runs, wait on the same promise, and are released in the SAME tick
 * — ten container creations / media_publish calls for identical content at
 * once, exactly the burst the stagger exists to prevent (FB error-368
 * throttles last hours). The same collapse happens when a human Retry re-arms
 * every failed target with no delay.
 *
 * The pacer re-imposes the spacing right before dispatch: consecutive
 * dispatches for one (post, platform) are at least `spacingMs` apart, in the
 * order they ask. When jobs already arrive spaced by the stagger (the normal
 * case) it waits for nothing.
 *
 * Per process — there is one worker container (see local-claims.ts).
 */

export interface DispatchSlot {
  /** When this dispatch may proceed (epoch ms). */
  slotAt: number;
  /** How long the caller must wait from `now`. */
  waitMs: number;
}

/**
 * Pure slot arithmetic. `lastSlotAt` is the slot most recently handed out for
 * this key (undefined when none is remembered).
 */
export function planDispatchSlot(lastSlotAt: number | undefined, now: number, spacingMs: number): DispatchSlot {
  const spacing = Math.max(0, spacingMs);
  const earliest = lastSlotAt === undefined ? now : lastSlotAt + spacing;
  const slotAt = Math.max(now, earliest);
  return { slotAt, waitMs: slotAt - now };
}

/**
 * Entries whose last slot is older than this are forgotten. Any fan-out this
 * process is still pacing hands out slots well within it, so pruning can never
 * let two dispatches of one post collide.
 */
export const DISPATCH_PACER_RETENTION_MS = 30 * 60 * 1000;

export function createDispatchPacer(deps: {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const lastSlot = new Map<string, number>();

  const prune = (t: number) => {
    for (const [key, at] of lastSlot) {
      if (t - at > DISPATCH_PACER_RETENTION_MS) lastSlot.delete(key);
    }
  };

  return {
    /**
     * Reserve the next slot for `key` and wait for it. The reservation is
     * made synchronously, before any await, so concurrent callers in one tick
     * receive distinct, ordered slots.
     */
    async waitTurn(key: string, spacingMs: number): Promise<number> {
      const t = now();
      prune(t);
      const { slotAt, waitMs } = planDispatchSlot(lastSlot.get(key), t, spacingMs);
      lastSlot.set(key, slotAt);
      if (waitMs > 0) await sleep(waitMs);
      return waitMs;
    },
    /** Test/diagnostic helper. */
    size(): number {
      return lastSlot.size;
    },
  };
}
