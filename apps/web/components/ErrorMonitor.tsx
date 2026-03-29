"use client";

import { useEffect, useCallback, Component, type ReactNode } from "react";

/**
 * Send error to monitoring API (fire-and-forget, never throws)
 */
async function reportError(data: {
  source: "frontend" | "api";
  severity?: "error" | "warning" | "critical";
  message: string;
  stack?: string;
  endpoint?: string;
  metadata?: Record<string, any>;
}) {
  try {
    await fetch("/api/trpc/monitor.logError", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        json: {
          source: data.source,
          severity: data.severity || "error",
          message: data.message.slice(0, 5000),
          stack: data.stack?.slice(0, 10000),
          endpoint: data.endpoint || (typeof window !== "undefined" ? window.location.pathname : undefined),
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : undefined,
          metadata: data.metadata,
        },
      }),
    });
  } catch {
    // Never let monitoring itself cause errors
  }
}

/**
 * Global error listener — catches unhandled errors + promise rejections
 */
export function GlobalErrorMonitor() {
  const handleError = useCallback((event: ErrorEvent) => {
    reportError({
      source: "frontend",
      severity: "error",
      message: event.message || "Unhandled error",
      stack: event.error?.stack,
      metadata: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  }, []);

  const handleRejection = useCallback((event: PromiseRejectionEvent) => {
    const err = event.reason;
    reportError({
      source: "frontend",
      severity: "error",
      message: err?.message || String(err) || "Unhandled promise rejection",
      stack: err?.stack,
      metadata: { type: "unhandledRejection" },
    });
  }, []);

  useEffect(() => {
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);

    // Intercept console.error to capture React errors and other issues
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      originalConsoleError.apply(console, args);
      const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      // Only report actual errors, not React dev warnings
      if (
        message.includes("Error") &&
        !message.includes("Warning:") &&
        !message.includes("React does not recognize") &&
        !message.includes("validateDOMNesting")
      ) {
        reportError({
          source: "frontend",
          severity: "warning",
          message: message.slice(0, 2000),
          metadata: { type: "console.error" },
        });
      }
    };

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
      console.error = originalConsoleError;
    };
  }, [handleError, handleRejection]);

  return null;
}

/**
 * React Error Boundary — catches render errors
 */
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError({
      source: "frontend",
      severity: "critical",
      message: error.message,
      stack: error.stack,
      metadata: {
        componentStack: info.componentStack?.slice(0, 2000),
        type: "react_error_boundary",
      },
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="flex min-h-[200px] items-center justify-center p-8">
            <div className="text-center space-y-2">
              <p className="text-sm font-medium text-destructive">Something went wrong</p>
              <p className="text-xs text-muted-foreground">{this.state.error?.message}</p>
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="mt-2 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
              >
                Try Again
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}

/** Export reportError for manual use in try/catch blocks */
export { reportError };
