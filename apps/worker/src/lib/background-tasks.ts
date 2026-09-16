/**
 * Registry of fire-and-forget bookkeeping that must survive a graceful drain
 * (2026-09-16).
 *
 * WHY. BullMQ 5.x emits `failed` with a plain EventEmitter call after
 * `moveToFailed` resolves — it never awaits an async listener. worker.close()
 * therefore resolves while a `failed` listener is still writing the terminal
 * state (post status, notification, publish email, super-text failure, caption
 * fan-out safety valve). Before the bounded drain existed, Docker SIGKILLed the
 * process after 10s anyway; with a 270s drain, jobs now routinely FINISH during
 * shutdown, so exiting straight after close() would cut exactly that
 * bookkeeping short — a post left PUBLISHING, a report email lost, a DRAFT
 * stranded with superText.pendingBurn set.
 *
 * Listeners register their promise here; the shutdown handler awaits whatever
 * is still pending (bounded by the remaining drain budget) before exiting.
 *
 * Zero imports on purpose, so it is unit-testable in milliseconds.
 */

const pending = new Set<Promise<unknown>>();

/**
 * Track a background promise until it settles. Returns the same promise.
 * A rejection is swallowed HERE (the caller is expected to handle/log its own
 * errors); tracking must never create an unhandled rejection.
 */
export function trackBackgroundTask<T>(task: Promise<T>): Promise<T> {
  const tracked = task.then(
    () => undefined,
    () => undefined
  );
  pending.add(tracked);
  void tracked.then(() => pending.delete(tracked));
  return task;
}

export function pendingBackgroundTaskCount(): number {
  return pending.size;
}

/**
 * Wait for every tracked task to settle, or for `timeoutMs`, whichever comes
 * first. Tasks registered WHILE waiting are included (a failed listener can be
 * emitted by a job that finishes during the wait). Never rejects.
 */
export async function awaitBackgroundTasks(timeoutMs: number): Promise<"settled" | "timeout"> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled([...pending]).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), remaining);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) return pending.size > 0 ? "timeout" : "settled";
  }
  return "settled";
}
