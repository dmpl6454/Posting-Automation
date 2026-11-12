/**
 * Dashboard "publishing is delayed" banner — pure rules (2026-11-12).
 * Fed by GET /api/health/publishing. Only `down` / `delayed` show a banner:
 * `unknown` means the web server could not read anything, which says nothing
 * reliable about publishing and would only alarm users.
 */
export interface PublishingHealthPayload {
  status?: string;
  oldestOverdueMinutes?: number | null;
}

export function publishingBannerText(h: PublishingHealthPayload | null | undefined): string | null {
  if (!h) return null;
  if (h.status === "down") {
    return "Publishing is paused right now. Your scheduled posts are safe and will go out automatically as soon as it resumes.";
  }
  if (h.status === "delayed") {
    const late = h.oldestOverdueMinutes;
    return `Publishing is running behind${typeof late === "number" && late > 0 ? ` (up to ${formatLate(late)} late)` : ""}. Your scheduled posts are safe and will go out shortly.`;
  }
  return null;
}

export function formatLate(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.round(minutes / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

export const PUBLISHING_BANNER_POLL_MS = 60_000;
