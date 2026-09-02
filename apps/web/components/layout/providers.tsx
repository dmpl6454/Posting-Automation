"use client";

import { useEffect } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { applyAccent, readStoredAccent } from "~/lib/accent";
import { TRPCProvider } from "~/lib/trpc/react";
import { Toaster } from "~/components/ui/toaster";
import { OrgInit } from "./org-init";
import { GlobalErrorMonitor, ErrorBoundary } from "~/components/ErrorMonitor";
import { ActiveTaskProvider } from "~/lib/active-task";

/**
 * Re-applies the saved accent on every load.
 *
 * The accent is written as inline vars on :root, which do not survive a
 * navigation/refresh — so without this the picker would only hold until the
 * next page load. Runs in an effect (not during render) because localStorage
 * is unavailable on the server.
 */
function AccentInit() {
  useEffect(() => {
    applyAccent(readStoredAccent());
  }, []);
  return null;
}

function ActiveTaskProviderWithSession({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const userId = (session?.user as any)?.id as string | undefined;
  return <ActiveTaskProvider userId={userId}>{children}</ActiveTaskProvider>;
}

export function Providers({
  children,
  forcedTheme,
}: {
  children: React.ReactNode;
  /**
   * Pin the theme for this subtree (e.g. the /admin console is a light-only
   * design — passing "light" keeps `--foreground` dark so table text/badges
   * stay visible even when the OS is in dark mode). Omit to follow the OS.
   */
  forcedTheme?: string;
}) {
  return (
    <SessionProvider>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        forcedTheme={forcedTheme}
      >
        <TRPCProvider>
          <ActiveTaskProviderWithSession>
            <GlobalErrorMonitor />
            <AccentInit />
            <OrgInit />
            <ErrorBoundary>{children}</ErrorBoundary>
            <Toaster />
          </ActiveTaskProviderWithSession>
        </TRPCProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
