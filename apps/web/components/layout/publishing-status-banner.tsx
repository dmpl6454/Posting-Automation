"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  publishingBannerText,
  PUBLISHING_BANNER_POLL_MS,
  type PublishingHealthPayload,
} from "~/lib/publishing-banner";

/**
 * Tells every signed-in user when publishing has stalled (2026-11-12), so a
 * worker outage is never silent again. Polls /api/health/publishing (cached
 * 30s server-side) once a minute while the tab is visible. A failed fetch
 * shows nothing: an unreachable health check is not evidence of an outage.
 */
export function PublishingStatusBanner() {
  const [health, setHealth] = useState<PublishingHealthPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/health/publishing", { cache: "no-store" });
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) return; // nginx HTML error page
        const body = (await res.json()) as PublishingHealthPayload;
        if (!cancelled) setHealth(body);
      } catch {
        /* keep the last known state */
      }
    };
    void load();
    const id = setInterval(load, PUBLISHING_BANNER_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const text = publishingBannerText(health);
  if (!text) return null;
  return (
    <div
      role="status"
      data-testid="publishing-status-banner"
      className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
      <span>{text}</span>
    </div>
  );
}
