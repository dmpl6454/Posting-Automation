"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { TRPCProvider } from "~/lib/trpc/react";
import { Toaster } from "~/components/ui/toaster";
import { OrgInit } from "./org-init";
import { GlobalErrorMonitor, ErrorBoundary } from "~/components/ErrorMonitor";

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
          <GlobalErrorMonitor />
          <OrgInit />
          <ErrorBoundary>{children}</ErrorBoundary>
          <Toaster />
        </TRPCProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
