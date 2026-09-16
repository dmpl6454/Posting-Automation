import { describe, it, expect } from "vitest";
import { trackBackgroundTask, pendingBackgroundTaskCount, awaitBackgroundTasks } from "./background-tasks";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("background-tasks — bookkeeping a graceful drain must wait for", () => {
  it("tracks a task until it settles and returns the same promise", async () => {
    const d = deferred<number>();
    const returned = trackBackgroundTask(d.promise);
    expect(returned).toBe(d.promise);
    expect(pendingBackgroundTaskCount()).toBe(1);
    d.resolve(7);
    await expect(returned).resolves.toBe(7);
    await awaitBackgroundTasks(1_000);
    expect(pendingBackgroundTaskCount()).toBe(0);
  });

  it("a rejecting task is untracked and never becomes an unhandled rejection via the tracker", async () => {
    const d = deferred();
    const returned = trackBackgroundTask(d.promise);
    returned.catch(() => undefined); // the caller owns its own error handling
    d.reject(new Error("boom"));
    await expect(awaitBackgroundTasks(1_000)).resolves.toBe("settled");
    expect(pendingBackgroundTaskCount()).toBe(0);
  });

  it("waits for tasks registered WHILE it is waiting", async () => {
    const first = deferred();
    const second = deferred();
    trackBackgroundTask(first.promise);
    const waiting = awaitBackgroundTasks(1_000);
    first.promise.then(() => trackBackgroundTask(second.promise));
    first.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(pendingBackgroundTaskCount()).toBe(1);
    second.resolve();
    await expect(waiting).resolves.toBe("settled");
  });

  it("gives up at the budget and reports it", async () => {
    const stuck = deferred();
    trackBackgroundTask(stuck.promise);
    const started = Date.now();
    await expect(awaitBackgroundTasks(30)).resolves.toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
    stuck.resolve();
    await awaitBackgroundTasks(1_000);
  });

  it("returns settled immediately when nothing is pending (and for a zero budget)", async () => {
    await expect(awaitBackgroundTasks(0)).resolves.toBe("settled");
  });
});
