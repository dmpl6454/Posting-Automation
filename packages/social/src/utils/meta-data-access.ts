/**
 * Reads Meta's `data_access_expires_at` — the 90-day DATA-ACCESS window, which
 * is a completely separate clock from token expiry and is the real reason Meta
 * insights keep dying every few months.
 *
 * ── Why this exists (live-verified 2026-08-06) ────────────────────────────────
 * `debug_token` on freshly reconnected channels returns, for BOTH Facebook Page
 * tokens and Instagram user tokens:
 *
 *     expires_at             = 0        ⇒ "never expires"
 *     data_access_expires_at = +90 days
 *
 * So a token stays valid for POSTING indefinitely while silently losing the
 * right to READ data after 90 days. Because `expires_at` really is never,
 * `Channel.tokenExpiresAt` is correctly NULL — but that made the whole class of
 * failure invisible:
 *
 *   - `scheduleTokenRefreshes` filters `tokenExpiresAt: { lte: soon }`, and NULL
 *     can never satisfy `<=`, so it has NEVER selected a single Meta channel
 *     (measured: 1338 of 1339 active FB+IG channels unreachable by that cron).
 *   - Nothing tracked the 90-day clock, so every ~3 months all Meta insights
 *     went dead with no warning and the only cure was a manual reconnect.
 *
 * ⚠️ A SERVER-SIDE REFRESH CANNOT FIX THIS — verified empirically. Re-exchanging
 * a token via `grant_type=fb_exchange_token` returns a new token whose
 * `data_access_expires_at` is byte-identical (delta: 0 days). Only a USER
 * re-authorization through the consent dialog resets the window. That is why the
 * fix is to TRACK the cliff and prompt a reconnect before it lands, rather than
 * to make the refresh cron reach these channels — refresh would be a no-op.
 */
import { fetchT } from "./fetch-timeout";

export interface MetaTokenWindow {
  /** When the token itself expires. null ⇒ never (the normal Meta case). */
  expiresAt: Date | null;
  /** When DATA ACCESS lapses — the 90-day clock. null ⇒ not reported. */
  dataAccessExpiresAt: Date | null;
  /** Scopes Meta says are granted, for the reconnect prompt. */
  scopes: string[];
  valid: boolean;
}

/**
 * One `debug_token` call. Meant to be called ONCE per OAuth consent (the same
 * user token backs every Page / IG account from that consent), not once per
 * channel — a per-channel sweep over ~1300 channels trips Meta's app-level rate
 * limit (`#4 Application request limit reached`, observed during the audit).
 *
 * Returns null on any failure: this is enrichment, and it must never be able to
 * fail a channel connect.
 */
export async function fetchMetaTokenWindow(
  accessToken: string,
  clientId: string,
  clientSecret: string,
  apiVersion = "v18.0"
): Promise<MetaTokenWindow | null> {
  if (!accessToken || !clientId || !clientSecret) return null;
  try {
    const appToken = `${clientId}|${clientSecret}`;
    const res = await fetchT(
      `https://graph.facebook.com/${apiVersion}/debug_token` +
        `?input_token=${encodeURIComponent(accessToken)}` +
        `&access_token=${encodeURIComponent(appToken)}`,
      {},
      15_000
    );
    const body: any = await res.json().catch(() => null);
    const d = body?.data;
    if (!res.ok || !d) return null;
    // Meta encodes "never" as 0 (or omits the field) — NOT as the epoch.
    const toDate = (v: unknown): Date | null => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
    };
    return {
      expiresAt: toDate(d.expires_at),
      dataAccessExpiresAt: toDate(d.data_access_expires_at),
      scopes: Array.isArray(d.scopes) ? d.scopes.filter((s: unknown) => typeof s === "string") : [],
      valid: !!d.is_valid,
    };
  } catch {
    return null;
  }
}
