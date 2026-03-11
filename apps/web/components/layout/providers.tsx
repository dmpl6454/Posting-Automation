"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { TRPCProvider } from "~/lib/trpc/react";
import { Toaster } from "~/components/ui/toaster";
import { OrgInit } from "./org-init";

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
          <OrgInit />
          {children}
          <Toaster />
        </TRPCProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
