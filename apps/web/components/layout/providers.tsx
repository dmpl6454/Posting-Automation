"use client";

import { SessionProvider, useSession } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { TRPCProvider } from "~/lib/trpc/react";
import { Toaster } from "~/components/ui/toaster";
import { OrgInit } from "./org-init";
import { GlobalErrorMonitor, ErrorBoundary } from "~/components/ErrorMonitor";
import { ActiveTaskProvider } from "~/lib/active-task";

function ActiveTaskProviderWithSession({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const userId = (session?.user as any)?.id as string | undefined;
  return <ActiveTaskProvider userId={userId}>{children}</ActiveTaskProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <TRPCProvider>
          <ActiveTaskProviderWithSession>
            <GlobalErrorMonitor />
            <OrgInit />
            <ErrorBoundary>{children}</ErrorBoundary>
            <Toaster />
          </ActiveTaskProviderWithSession>
        </TRPCProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
