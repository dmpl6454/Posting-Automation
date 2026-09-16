/**
 * Graceful worker shutdown — bounded drain (2026-09-16).
 *
 * WHY. The 2026-09-15 deploy killed 10 in-flight Instagram publishes: Docker's
 * default stop grace is 10s, an IG reel publish takes 80-120s, so every job
 * mid-publish was SIGKILLed. Those targets then sat orphaned at PUBLISHING for
 * 30 minutes until the watchdog reaped them as plain FAILED with retryCount 0
 * — which also means a human Retry skips the duplicate pre-flight. The worker
 * service now gets `stop_grace_period: 5m` (docker-compose.prod.yml), and this
 * module makes the process USE that window: stop taking new jobs, let the
 * in-flight ones finish, and exit on our own terms a little BEFORE Docker's
 * SIGKILL — so the exit is logged and the health server closes cleanly.
 *
 * Kept free of BullMQ/Prisma imports so the rules are unit-testable in ms (same
 * split as video-overlay-args.ts / publish-stagger.ts).
 */

/** 30s inside the compose `stop_grace_period: 5m`, so we always exit before SIGKILL. */
export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 270_000;
/** A drain shorter than this cannot finish even a text publish. */
export const MIN_WORKER_SHUTDOWN_TIMEOUT_MS = 1_000;
/**
 * Upper clamp. Beyond the compose grace Docker SIGKILLs first anyway, and it
 * keeps the value far below Node's setTimeout limit (2^31-1 ms) — a larger
 * delay is silently treated as 1ms, which would turn "wait a long time" into
 * "exit immediately".
 */
export const MAX_WORKER_SHUTDOWN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * WORKER_SHUTDOWN_TIMEOUT_MS → drain budget (ms). Strict: digits only, clamped
 * to [MIN, MAX]. Unset, `""` (compose's explicit `environment:` allowlist
 * delivers an unset `${KEY:-}` as an empty string) or anything unparseable →
 * the default — never 0, which would drop in-flight publishes exactly like the
 * 10s grace did.
 */
export function resolveShutdownTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env.WORKER_SHUTDOWN_TIMEOUT_MS;
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS;
  return Math.min(MAX_WORKER_SHUTDOWN_TIMEOUT_MS, Math.max(MIN_WORKER_SHUTDOWN_TIMEOUT_MS, Number(raw)));
}

/**
 * Best-effort count of jobs a BullMQ Worker is currently processing, for the
 * shutdown log only. BullMQ 5.x exposes it on the (protected) lock manager and
 * has no public getter, so this is duck-typed and returns null rather than
 * throwing when the shape differs (e.g. after a BullMQ upgrade).
 */
export function readActiveJobCount(worker: unknown): number | null {
  try {
    const lockManager = (worker as { lockManager?: { getActiveJobCount?: unknown } } | null)?.lockManager;
    const getter = lockManager?.getActiveJobCount;
    if (typeof getter !== "function") return null;
    const n: unknown = getter.call(lockManager);
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export type DrainOutcome = "drained" | "timeout" | "error";

/**
 * Race `drain` against `timeoutMs`. Never rejects; always clears its timer so
 * a drain that finishes early leaves nothing scheduled.
 */
export async function raceDrain(
  drain: Promise<unknown>,
  timeoutMs: number
): Promise<{ outcome: DrainOutcome; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ outcome: DrainOutcome }>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([
      drain.then(
        () => ({ outcome: "drained" as const }),
        (error: unknown) => ({ outcome: "error" as const, error })
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface GracefulShutdownDeps {
  /** Marks health-check entries stopped. Runs before the drain starts. */
  markStopped: () => void;
  /** Resolves when every worker has finished its in-flight jobs (worker.close()). */
  closeWorkers: () => Promise<unknown>;
  closeHealthServer: () => void;
  exit: (code: number) => void;
  timeoutMs: number;
  /** In-flight post-publish jobs, or null when not cheaply knowable. */
  activePublishJobs?: () => number | null;
  /**
   * Waits (up to the given ms) for fire-and-forget `failed`-listener work that
   * BullMQ does not await — see lib/background-tasks.ts. Runs after the
   * workers have closed, within whatever is left of the drain budget.
   */
  awaitBackgroundTasks?: (timeoutMs: number) => Promise<"settled" | "timeout">;
  /** How many of those tasks are still pending (for the log only). */
  pendingBackgroundTasks?: () => number;
  log?: (msg: string) => void;
  warn?: (msg: string, err?: unknown) => void;
}

/**
 * Build the SIGTERM/SIGINT handler. Idempotent: Docker, pnpm and a human
 * pressing Ctrl+C twice can all deliver a second signal while the first drain
 * is still running — that must NOT start a second drain or cut the first one
 * short, so it only logs. (BullMQ's close() is itself idempotent, but a second
 * timer racing the first would exit on the wrong budget.)
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): (signal?: string) => Promise<void> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const warn = deps.warn ?? ((msg: string, err?: unknown) => console.error(msg, err ?? ""));
  let draining = false;

  return async (signal = "signal") => {
    if (draining) {
      log(`[Shutdown] ${signal} received while already draining — ignoring (drain continues)`);
      return;
    }
    draining = true;

    let active: number | null = null;
    try {
      active = deps.activePublishJobs?.() ?? null;
    } catch {
      active = null;
    }
    log(
      `\n[Shutdown] ${signal} received — no new jobs will start; draining in-flight work ` +
        `(active publish jobs: ${active ?? "unknown"}, budget ${Math.round(deps.timeoutMs / 1000)}s)`
    );

    try {
      deps.markStopped();
    } catch (err) {
      warn("[Shutdown] marking workers stopped failed (continuing):", err);
    }

    // Start closing IMMEDIATELY (before the race) so every worker stops
    // fetching at once; only the waiting is bounded.
    let drain: Promise<unknown>;
    try {
      drain = deps.closeWorkers();
    } catch (err) {
      drain = Promise.reject(err);
    }
    const started = Date.now();
    const { outcome, error } = await raceDrain(drain, deps.timeoutMs);
    const secs = Math.round((Date.now() - started) / 1000);

    if (outcome === "drained") {
      log(`[Shutdown] All workers drained in ${secs}s.`);
    } else if (outcome === "timeout") {
      let left: number | null = null;
      try {
        left = deps.activePublishJobs?.() ?? null;
      } catch {
        left = null;
      }
      log(
        `[Shutdown] Drain budget of ${Math.round(deps.timeoutMs / 1000)}s exhausted — exiting with ` +
          `${left ?? "unknown"} publish job(s) still running. BullMQ marks them stalled once their ` +
          `lock expires and the next worker picks them up under the normal publish guards.`
      );
    } else {
      warn(`[Shutdown] Closing workers failed after ${secs}s (exiting anyway):`, error);
    }

    // BullMQ emits `failed` without awaiting its async listeners, so close()
    // can resolve while a job's terminal bookkeeping (post status, report
    // email, super-text failure, caption fan-out valve) is still running.
    // Give it whatever is left of the budget before exiting.
    if (deps.awaitBackgroundTasks) {
      const remaining = deps.timeoutMs - (Date.now() - started);
      const pendingCount = (() => {
        try {
          return deps.pendingBackgroundTasks?.() ?? null;
        } catch {
          return null;
        }
      })();
      if (pendingCount !== 0) {
        try {
          const tasks = await deps.awaitBackgroundTasks(Math.max(0, remaining));
          log(
            tasks === "settled"
              ? `[Shutdown] Pending job bookkeeping finished.`
              : `[Shutdown] Pending job bookkeeping did not finish within the drain budget — exiting anyway.`
          );
        } catch (err) {
          warn("[Shutdown] waiting for job bookkeeping failed (exiting anyway):", err);
        }
      }
    }

    try {
      deps.closeHealthServer();
    } catch (err) {
      warn("[Shutdown] closing the health server failed (exiting anyway):", err);
    }
    log("Workers stopped. Exiting.");
    deps.exit(0);
  };
}
