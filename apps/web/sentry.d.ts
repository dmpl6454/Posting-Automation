declare module "@sentry/nextjs" {
  export function init(options: {
    dsn?: string;
    tracesSampleRate?: number;
    replaysSessionSampleRate?: number;
    replaysOnErrorSampleRate?: number;
    enabled?: boolean;
  }): void;
  export function captureException(error: unknown): void;
}
