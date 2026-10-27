/**
 * TikTok's RESEARCH API switch (2026-10-28).
 *
 * Social listening and brand-content sync query /v2/research/video/query/,
 * which only a separately approved research client may call. Production holds
 * the CONTENT POSTING app's keys, so those calls can only be refused — they
 * cost a token mint plus a failed query every 30 min (listening) / 4 h (brand
 * sync) and return nothing. Off unless a research app is approved and the
 * operator turns this on.
 *
 * ⚠️ FAIL-CLOSED (`=== "true"`): docker-compose.prod.yml uses an explicit
 * `environment:` allowlist, so an unplumbed key arrives as "" — which must read
 * as OFF, never as on.
 */
export function isTikTokResearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TIKTOK_RESEARCH_ENABLED === "true";
}
