import { describe, it, expect } from "vitest";
import { planDispatchSlot, createDispatchPacer, DISPATCH_PACER_RETENTION_MS } from "./dispatch-pacer";

describe("planDispatchSlot", () => {
  it("the first dispatch of a key goes now", () => {
    expect(planDispatchSlot(undefined, 1_000, 10_000)).toEqual({ slotAt: 1_000, waitMs: 0 });
  });

  it("a dispatch arriving inside the spacing waits for the rest of it", () => {
    expect(planDispatchSlot(1_000, 4_000, 10_000)).toEqual({ slotAt: 11_000, waitMs: 7_000 });
  });

  it("a dispatch arriving after the spacing (the normal stagger case) waits for nothing", () => {
    expect(planDispatchSlot(1_000, 12_000, 10_000)).toEqual({ slotAt: 12_000, waitMs: 0 });
  });

  it("a negative spacing is treated as zero", () => {
    expect(planDispatchSlot(1_000, 1_000, -5)).toEqual({ slotAt: 1_000, waitMs: 0 });
  });
});

function fakeClock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

describe("createDispatchPacer", () => {
  it("re-spaces a burst released in the SAME tick (the shared-encode join) — 10 targets, 10s apart", async () => {
    const clock = fakeClock();
    const pacer = createDispatchPacer(clock);
    const waits = await Promise.all(Array.from({ length: 10 }, () => pacer.waitTurn("post-1:INSTAGRAM", 10_000)));
    expect(waits).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000]);
  });

  it("adds nothing when jobs already arrive spaced by the stagger", async () => {
    const clock = fakeClock();
    const pacer = createDispatchPacer(clock);
    for (let i = 0; i < 5; i++) {
      expect(await pacer.waitTurn("post-1:INSTAGRAM", 10_000)).toBe(0);
      clock.advance(10_000);
    }
  });

  it("keys are independent: other posts and other platforms are never delayed", async () => {
    const clock = fakeClock();
    const pacer = createDispatchPacer(clock);
    expect(await pacer.waitTurn("post-1:INSTAGRAM", 10_000)).toBe(0);
    expect(await pacer.waitTurn("post-1:FACEBOOK", 10_000)).toBe(0);
    expect(await pacer.waitTurn("post-2:INSTAGRAM", 10_000)).toBe(0);
    expect(await pacer.waitTurn("post-1:INSTAGRAM", 10_000)).toBe(10_000);
  });

  it("honours the platform's configured spacing", async () => {
    const clock = fakeClock();
    const pacer = createDispatchPacer(clock);
    await pacer.waitTurn("p:INSTAGRAM", 5_000);
    expect(await pacer.waitTurn("p:INSTAGRAM", 5_000)).toBe(5_000);
  });

  it("forgets keys once they are older than the retention window", async () => {
    const clock = fakeClock();
    const pacer = createDispatchPacer(clock);
    await pacer.waitTurn("old", 10_000);
    clock.advance(DISPATCH_PACER_RETENTION_MS + 20_000);
    await pacer.waitTurn("new", 10_000);
    expect(pacer.size()).toBe(1);
  });
});
