"use client";

import { useEffect } from "react";

/**
 * Starts browser Sentry AFTER the page is up (2026-11-10): it waits for the
 * browser to be idle, asks /api/client-config whether a DSN is set, and only
 * then downloads the SDK. With no DSN the page downloads nothing extra; with
 * one, the SDK never competes with first paint. Reports errors plus a sample
 * of page loads with Core Web Vitals (LCP, INP, CLS) — real-user speed.
 * No session replay.
 */
export function SentryLazyInit() {
  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      try {
        const res = await fetch("/api/client-config", { credentials: "omit" });
        if (!res.ok) return;
        const body = (await res.json()) as { sentry: { dsn: string; environment?: string; tracesSampleRate?: number; release?: string } | null };
        if (cancelled || !body?.sentry?.dsn) return;
        const [Sentry, { sentryBaseOptions }] = await Promise.all([
          import("@sentry/browser"),
          import("~/lib/sentry-options"),
        ]);
        if (cancelled) return;
        Sentry.init({
          ...sentryBaseOptions(body.sentry),
          integrations: [Sentry.browserTracingIntegration()],
        });
      } catch {
        // Monitoring must never break the app.
      }
    };
    const w = window as any;
    const handle = typeof w.requestIdleCallback === "function"
      ? w.requestIdleCallback(start, { timeout: 5000 })
      : window.setTimeout(start, 2000);
    return () => {
      cancelled = true;
      if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);
  return null;
}
