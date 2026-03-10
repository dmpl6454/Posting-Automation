import pino from "pino";
import type { Logger } from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Root logger instance configured with structured JSON logging in production
 * and pretty-printed output in development.
 */
export const logger: Logger = pino({
  level: process.env.LOG_LEVEL || "info",
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }),
  base: {
    service: process.env.SERVICE_NAME,
    version: process.env.npm_package_version,
  },
});

/**
 * Create a child logger scoped to a specific module or component.
 *
 * @param name - A descriptive name for the child logger (e.g. "post-worker", "auth-router")
 * @returns A Pino child logger with the given name attached
 */
export function createLogger(name: string): Logger {
  return logger.child({ name });
}

/**
 * Log an HTTP request with method, path, status code, and duration.
 */
export function logRequest(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
): void {
  logger.info(
    {
      msg: "http_request",
      method,
      path,
      statusCode,
      durationMs,
    },
    `${method} ${path} ${statusCode} ${durationMs}ms`,
  );
}

/**
 * Log an error with optional context metadata.
 */
export function logError(error: unknown, context?: Record<string, unknown>): void {
  if (error instanceof Error) {
    logger.error(
      {
        err: {
          message: error.message,
          name: error.name,
          stack: error.stack,
        },
        ...context,
      },
      error.message,
    );
  } else {
    logger.error(
      {
        err: error,
        ...context,
      },
      "Unknown error",
    );
  }
}

export type { Logger };
