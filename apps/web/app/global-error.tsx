"use client";

import { useEffect } from "react";
import { Button } from "~/components/ui/button";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Reported only if Sentry was started (SentryLazyInit, when SENTRY_DSN is
    // set); otherwise captureException is a no-op. Loaded lazily so the SDK is
    // never part of this page's bundle.
    console.error("Unhandled error:", error);
    import("@sentry/browser")
      .then((Sentry) => Sentry.captureException(error))
      .catch(() => {});
  }, [error]);

  return (
    <html>
      <body className="flex min-h-dvh items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <h2 className="text-2xl font-bold">Something went wrong!</h2>
          <p className="text-muted-foreground">An unexpected error occurred. Our team has been notified.</p>
          <Button onClick={reset}>Try again</Button>
        </div>
      </body>
    </html>
  );
}
