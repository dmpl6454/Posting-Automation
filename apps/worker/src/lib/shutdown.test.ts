import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createGracefulShutdown,
  raceDrain,
  readActiveJobCount,
  resolveShutdownTimeoutMs,
  DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
  MIN_WORKER_SHUTDOWN_TIMEOUT_MS,
  MAX_WORKER_SHUTDOWN_TIMEOUT_MS,
} from "./shutdown";

// 2026-09-16: the 2026-09-15 deploy SIGKILLed 10 in-flight Instagram publishes
// (10s Docker grace vs an 80-120s reel publish). These lock the bounded drain
// that now uses the 5-minute stop_grace_period.

describe("resolveShutdownTimeoutMs", () => {
  it("defaults to 270s — 30s inside the 5m compose grace", () => {
    expect(DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS).toBe(270_000);
    expect(DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS).toBeLessThan(5 * 60 * 1000);
    expect(resolveShutdownTimeoutMs({})).toBe(270_000);
  });

  it.each(["", "abc", "-5", " 120000", "120000 ", "120s", "1e5", "1200.5", "0x100"])(
    "falls back to the default for %j (never 0)",
    (raw) => {
      expect(resolveShutdownTimeoutMs({ WORKER_SHUTDOWN_TIMEOUT_MS: raw })).toBe(270_000);
    }
  );

  it("accepts a plain integer inside the bounds", () => {
    expect(resolveShutdownTimeoutMs({ WORKER_SHUTDOWN_TIMEOUT_MS: "120000" })).toBe(120_000);
  });

  it("clamps 0 up to the floor and huge values down to the ceiling", () => {
    expect(resolveShutdownTimeoutMs({ WORKER_SHUTDOWN_TIMEOUT_MS: "0" })).toBe(MIN_WORKER_SHUTDOWN_TIMEOUT_MS);
    expect(resolveShutdownTimeoutMs({ WORKER_SHUTDOWN_TIMEOUT_MS: "99999999999" })).toBe(
      MAX_WORKER_SHUTDOWN_TIMEOUT_MS
    );
    expect(resolveShutdownTimeoutMs({ WORKER_SHUTDOWN_TIMEOUT_MS: "9".repeat(400) })).toBe(
      MAX_WORKER_SHUTDOWN_TIMEOUT_MS
    );
  });

  it("the ceiling stays below Node's setTimeout overflow (2^31-1 ms → treated as 1ms)", () => {
    expect(MAX_WORKER_SHUTDOWN_TIMEOUT_MS).toBeLessThan(2 ** 31 - 1);
  });
});

describe("readActiveJobCount", () => {
  it("reads BullMQ 5.x's lock-manager count", () => {
    const worker = { lockManager: { trackedJobs: new Map([["a", 1], ["b", 2]]), getActiveJobCount() { return this.trackedJobs.size; } } };
    expect(readActiveJobCount(worker)).toBe(2);
  });

  it("returns null instead of throwing when the shape is not there", () => {
    expect(readActiveJobCount(null)).toBeNull();
    expect(readActiveJobCount(undefined)).toBeNull();
    expect(readActiveJobCount({})).toBeNull();
    expect(readActiveJobCount({ lockManager: {} })).toBeNull();
    expect(readActiveJobCount({ lockManager: { getActiveJobCount: 3 } })).toBeNull();
    expect(readActiveJobCount({ lockManager: { getActiveJobCount: () => "3" } })).toBeNull();
    expect(readActiveJobCount({ lockManager: { getActiveJobCount: () => NaN } })).toBeNull();
    expect(
      readActiveJobCount({
        lockManager: {
          getActiveJobCount: () => {
            throw new Error("boom");
          },
        },
      })
    ).toBeNull();
  });
});

describe("raceDrain", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports drained and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const result = await raceDrain(Promise.resolve(), 10_000);
    expect(result).toEqual({ outcome: "drained" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports timeout when the drain outlives the budget", async () => {
    vi.useFakeTimers();
    const pending = raceDrain(new Promise(() => {}), 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ outcome: "timeout" });
  });

  it("never rejects — a failing close is reported as an error outcome", async () => {
    const err = new Error("redis gone");
    expect(await raceDrain(Promise.reject(err), 10_000)).toEqual({ outcome: "error", error: err });
  });

  it("a drain that rejects AFTER the timeout does not surface as an unhandled rejection", async () => {
    vi.useFakeTimers();
    let rejectLater!: (e: unknown) => void;
    const drain = new Promise((_, reject) => (rejectLater = reject));
    const pending = raceDrain(drain, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ outcome: "timeout" });
    // Real timers again: the fake clock also fakes setImmediate.
    vi.useRealTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      rejectLater(new Error("late"));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("createGracefulShutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(overrides: Partial<Parameters<typeof createGracefulShutdown>[0]> = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const deps = {
      timeoutMs: 270_000,
      markStopped: vi.fn(() => void calls.push("markStopped")),
      closeWorkers: vi.fn(async () => {
        calls.push("closeWorkers");
      }),
      closeHealthServer: vi.fn(() => void calls.push("closeHealthServer")),
      exit: vi.fn((code: number) => void calls.push(`exit:${code}`)),
      activePublishJobs: vi.fn(() => 4),
      log: (m: string) => void logs.push(m),
      warn: (m: string) => void logs.push(`WARN ${m}`),
      ...overrides,
    };
    return { deps, calls, logs, shutdown: createGracefulShutdown(deps) };
  }

  it("drains, then closes the health server, then exits 0 — in that order", async () => {
    const { calls, logs, shutdown } = harness();
    await shutdown("SIGTERM");
    expect(calls).toEqual(["markStopped", "closeWorkers", "closeHealthServer", "exit:0"]);
    expect(logs[0]).toContain("SIGTERM received");
    expect(logs[0]).toContain("active publish jobs: 4");
    expect(logs[0]).toContain("budget 270s");
    expect(logs.some((l) => l.includes("All workers drained"))).toBe(true);
  });

  it("waits for in-flight jobs instead of exiting early", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const { deps, shutdown } = harness({
      closeWorkers: vi.fn(() => new Promise<void>((r) => (finish = r))),
    });
    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(120_000); // a long IG reel publish still running
    expect(deps.exit).not.toHaveBeenCalled();
    expect(deps.closeHealthServer).not.toHaveBeenCalled();
    finish();
    await done;
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("exits 0 when the budget runs out, logging how many publishes were still running", async () => {
    vi.useFakeTimers();
    let active = 3;
    const { deps, logs, shutdown } = harness({
      timeoutMs: 1_000,
      closeWorkers: vi.fn(() => new Promise<void>(() => {})),
      activePublishJobs: vi.fn(() => active),
    });
    const done = shutdown("SIGTERM");
    active = 2;
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(deps.closeHealthServer).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
    const timeoutLog = logs.find((l) => l.includes("exhausted"));
    expect(timeoutLog).toContain("2 publish job(s) still running");
  });

  it("is idempotent — a second signal during the drain only logs", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const { deps, logs, shutdown } = harness({
      closeWorkers: vi.fn(() => new Promise<void>((r) => (finish = r))),
    });
    const first = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    await shutdown("SIGINT");
    await shutdown("SIGTERM");
    expect(deps.closeWorkers).toHaveBeenCalledTimes(1);
    expect(deps.markStopped).toHaveBeenCalledTimes(1);
    expect(deps.exit).not.toHaveBeenCalled();
    expect(logs.filter((l) => l.includes("already draining"))).toHaveLength(2);
    // The second signal did not shorten the first drain's budget either.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(deps.exit).not.toHaveBeenCalled();
    finish();
    await first;
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it("still exits when closing throws synchronously or rejects", async () => {
    const sync = harness({
      closeWorkers: vi.fn(() => {
        throw new Error("sync boom");
      }),
    });
    await sync.shutdown("SIGTERM");
    expect(sync.deps.exit).toHaveBeenCalledWith(0);
    expect(sync.logs.some((l) => l.startsWith("WARN [Shutdown] Closing workers failed"))).toBe(true);

    const async_ = harness({ closeWorkers: vi.fn(async () => Promise.reject(new Error("async boom"))) });
    await async_.shutdown("SIGTERM");
    expect(async_.deps.exit).toHaveBeenCalledWith(0);
    expect(async_.deps.closeHealthServer).toHaveBeenCalledTimes(1);
  });

  it("a failing health-mark, count or health-server close never blocks the exit", async () => {
    const { deps, logs, shutdown } = harness({
      markStopped: vi.fn(() => {
        throw new Error("mark");
      }),
      activePublishJobs: vi.fn(() => {
        throw new Error("count");
      }),
      closeHealthServer: vi.fn(() => {
        throw new Error("server");
      }),
    });
    await shutdown("SIGTERM");
    expect(deps.closeWorkers).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(logs[0]).toContain("active publish jobs: unknown");
  });

  it("reports an unknown count when the worker shape is not readable", async () => {
    const { logs, shutdown } = harness({ activePublishJobs: () => null });
    await shutdown("SIGINT");
    expect(logs[0]).toContain("SIGINT received");
    expect(logs[0]).toContain("active publish jobs: unknown");
  });
});
