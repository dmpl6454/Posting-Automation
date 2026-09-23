/**
 * Graph API timestamps look like "2026-09-19T10:00:00+0000" — an ISO-8601
 * BASIC-format offset (no colon). V8 parses that, but WebKit's Date parser has
 * historically returned Invalid Date for it, which would render "Invalid Date"
 * (or throw inside date-fns) on every comment for Safari/iOS users. Insert the
 * colon so every engine sees the extended format "+00:00".
 *
 * Returns null for empty/unparseable input — callers render nothing rather
 * than a fabricated time.
 */
export function parseGraphTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
