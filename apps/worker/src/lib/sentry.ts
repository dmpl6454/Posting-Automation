import * as Sentry from "@sentry/node";

export function initSentry() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    enabled: process.env.NODE_ENV === "production",
  });
}

export { Sentry };
