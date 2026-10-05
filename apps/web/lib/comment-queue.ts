/**
 * Unanswered-comments queue — the per-browser "Done" list (2026-10-05).
 *
 * "Done" means "I've dealt with this comment and won't reply" (a thank-you
 * emoji, spam you'd rather not hide). The server has no store for that — the
 * queue is recomputed live from Meta on every load — so it is remembered in
 * THIS browser only, keyed by the platform comment id (globally unique), and
 * pruned after DONE_TTL_MS so the key never grows without bound.
 *
 * Every storage access is wrapped: localStorage can be missing or throw
 * (private windows, blocked site data). The queue then simply forgets "Done"
 * on reload; nothing else depends on it.
 */

export const DONE_STORAGE_KEY = "pa:comments:queue-done:v1";
export const DONE_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

export type DoneMap = Record<string, number>;

/** Parse a stored map, dropping garbage and anything older than the TTL. */
export function parseDoneMap(raw: string | null | undefined, now: number = Date.now()): DoneMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: DoneMap = {};
  for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof id !== "string" || !id || typeof at !== "number" || !Number.isFinite(at)) continue;
    if (now - at > DONE_TTL_MS) continue;
    out[id] = at;
  }
  return out;
}

/** Add an id, keeping only the newest MAX_ENTRIES. */
export function addDone(map: DoneMap, id: string, now: number = Date.now()): DoneMap {
  const next: DoneMap = { ...map, [id]: now };
  const entries = Object.entries(next);
  if (entries.length <= MAX_ENTRIES) return next;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES));
}

export function removeDone(map: DoneMap, id: string): DoneMap {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

export function readDoneMap(): DoneMap {
  try {
    return parseDoneMap(window.localStorage.getItem(DONE_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function writeDoneMap(map: DoneMap): void {
  try {
    window.localStorage.setItem(DONE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable — "Done" lasts until reload. Never break the queue.
  }
}

/** The windows offered in the queue's "last N days" picker. */
export const QUEUE_WINDOWS = [1, 3, 7, 14, 30] as const;
