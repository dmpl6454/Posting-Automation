// ── Shared types, helpers, and the fail-open contract ────────────────────────
//
// Every scraper in this package obeys ONE contract: it is FAIL-OPEN. Any non-200,
// login wall, short/empty body, parse miss, timeout, or thrown error resolves to a
// `null` metric (never a throw, never a wrong number). The caller therefore always
// keeps whatever value it already had on a miss — a scrape can only ever IMPROVE
// data, never corrupt it. This is the single most important property to preserve
// if you modify anything here.
//
// Nothing in this package touches a database, an ORM, env vars, or a logger. All of
// that is the consumer's choice, injected via `ScraperOptions`.

/** Injectable fetch so callers can supply a proxy/retrying/rate-limited fetch, and
 *  tests can supply a fixture fetch with no network. Defaults to global `fetch`. */
export type FetchFn = typeof fetch;

/** Optional usage/telemetry hook. The original app fed this into a cost sheet; here
 *  it is a no-op unless you pass one. Fire-and-forget — never awaited, never blocks. */
export type UsageHook = (u: {
  provider: string;
  operation: string;
  calls: number;
  units: number;
}) => void;

/** Options every scraper accepts. All fields optional — sensible defaults apply. */
export interface ScraperOptions {
  /** Custom fetch (proxy, retry, rate-limit). Default: global fetch. */
  fetchImpl?: FetchFn;
  /** Telemetry callback. Default: no-op. */
  onUsage?: UsageHook;
  /** Per-request timeout in ms. Default: 12_000. */
  timeoutMs?: number;
  /** A `console`-like sink for the one-line-per-account diagnostics. Pass `null`
   *  to silence. Default: the global `console`. */
  logger?: Pick<Console, "log" | "error"> | null;
}

export interface ResolvedOptions {
  fetchImpl: FetchFn;
  onUsage: UsageHook;
  timeoutMs: number;
  logger: Pick<Console, "log" | "error"> | null;
}

export function resolveOptions(o?: ScraperOptions): ResolvedOptions {
  return {
    fetchImpl: o?.fetchImpl ?? fetch,
    onUsage: o?.onUsage ?? (() => {}),
    timeoutMs: o?.timeoutMs ?? 12_000,
    logger: o?.logger === undefined ? console : o.logger,
  };
}

/** A User-Agent that reliably gets the server-rendered (un-walled) HTML from
 *  Facebook, Snapchat, and YouTube. Facebook/Snapchat serve a 600KB empty app
 *  shell to a normal Chrome UA but the full JSON-embedded HTML to Googlebot. */
export const GOOGLEBOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

/** fetch with an AbortController timeout. Returns null on any network/abort error
 *  (fail-open) — the caller treats null as "miss", never as a crash. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: FetchFn,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Number parsing (shared across platforms) ─────────────────────────────────
//
// Indian audiences dominate this data, so every count parser must understand
// both Western (K/M/B) and Indian (lakh/crore, and Devanagari digits) notations.

/** Devanagari digit (०–९) → ASCII. Facebook/Snapchat localise Indian pages so a
 *  follower count may arrive as "१,४१,६३,०५२" instead of "14,163,052". */
export function devanagariToAscii(input: string): string {
  const map: Record<string, string> = {
    "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
    "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
  };
  return input.replace(/[०-९]/g, (d) => map[d] ?? d);
}

/** Decode the HTML entities that show up inside og: meta tags (numeric refs used
 *  for Devanagari digits, plus &amp; &quot; &#x27; etc.). Best-effort. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _; }
    })
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Parse "14M" / "1.2K" / "553,000" / "553 thousand" / "1,41,63,052" / "1.41 crore"
 *  → integer, or null. Handles Western AND Indian unit words. */
export function parseCount(text: string): number | null {
  const clean = text.replace(/,/g, "").trim();
  const m = clean.match(/^([\d.]+)\s*([KkMmBbLlCc]|thousand|million|billion|lakh|crore)?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = (m[2] || "").toLowerCase();
  if (u === "k" || u === "thousand") n *= 1_000;
  else if (u === "m" || u === "million") n *= 1_000_000;
  else if (u === "b" || u === "billion") n *= 1_000_000_000;
  else if (u === "l" || u === "lakh") n *= 100_000;
  else if (u === "c" || u === "crore") n *= 10_000_000;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Result of a follower-count scrape. `followers === null` means "miss — keep the
 *  existing value". `walled` distinguishes a hard block (login wall / non-200) from
 *  "profile loaded but no count found", so a caller can short-circuit after N walls. */
export interface FollowerResult {
  followers: number | null;
  walled?: boolean;
}

/** Result of a per-post engagement scrape. Any field may be null (honest absence —
 *  e.g. Snapchat exposes no like metric, so `likes` is ALWAYS null there). */
export interface EngagementResult {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  caption: string | null;
  walled?: boolean;
}
