/**
 * Regression guard for the render-concurrency semaphore (stability guard,
 * 2026-07-18). Every self-launched Puppeteer browser in news-image-generator
 * goes through this semaphore so N concurrent renders can never spawn N
 * Chromiums. The critical invariants:
 *   1. run() ALWAYS releases the slot — even when the wrapped fn throws —
 *      or a single crashed render would permanently leak a slot and
 *      eventually deadlock all creative rendering.
 *   2. Excess acquires WAIT (never fail) and are served FIFO.
 *   3. Concurrency never exceeds the configured max.
 */
import { describe, it, expect } from "vitest";
import { createSemaphore } from "../tools/news-image-generator";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createSemaphore", () => {
  it("releases the slot when the wrapped fn throws (run + finally)", async () => {
    const sem = createSemaphore(1);

    await expect(
      sem.run(async () => {
        throw new Error("render crashed");
      })
    ).rejects.toThrow("render crashed");

    // If the throwing run leaked its slot, this second run would hang forever.
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("releases the slot on synchronous throw inside the fn", async () => {
    const sem = createSemaphore(1);
    await expect(
      sem.run(() => {
        throw new Error("sync boom");
      })
    ).rejects.toThrow("sync boom");
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("never exceeds max concurrency; excess renders wait (never fail)", async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const gate: Array<() => void> = [];

    const job = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => gate.push(r));
        active--;
      });

    const jobs = [job(), job(), job(), job(), job()];
    await tick();
    expect(peak).toBe(2); // only 2 running, 3 waiting

    // Drain: releasing each running job admits exactly one waiter.
    while (gate.length > 0 || active > 0) {
      const g = gate.shift();
      if (g) g();
      await tick();
    }
    await Promise.all(jobs);
    expect(peak).toBe(2); // waiting jobs never pushed concurrency past max
    expect(active).toBe(0);
  });

  it("hands the slot to waiters FIFO", async () => {
    const sem = createSemaphore(1);
    const order: number[] = [];
    await sem.acquire();
    const w1 = sem.acquire().then(() => order.push(1));
    const w2 = sem.acquire().then(() => order.push(2));
    sem.release(); // slot → w1
    await w1;
    sem.release(); // slot → w2
    await w2;
    expect(order).toEqual([1, 2]);
    sem.release();
  });

  it("manual acquire/release round-trips (launch-throw path)", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();
    sem.release(); // simulates puppeteer.launch throwing → immediate release
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("clamps max to at least 1", async () => {
    const sem = createSemaphore(0);
    await expect(sem.run(async () => "still works")).resolves.toBe("still works");
  });
});
