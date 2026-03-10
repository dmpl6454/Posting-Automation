declare module "@sentry/node" {
  export function init(options: {
    dsn?: string;
    tracesSampleRate?: number;
    enabled?: boolean;
  }): void;
  export function captureException(error: unknown): void;
}
