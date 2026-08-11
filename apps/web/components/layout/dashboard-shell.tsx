"use client";

import { useState } from "react";
import { Sidebar } from "~/components/layout/sidebar";
import { Header } from "~/components/layout/header";
import { ActivityPanel } from "~/components/layout/activity-panel";
import { ActiveTaskBar } from "~/components/layout/active-task-bar";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onMenuClick={() => setSidebarOpen(true)} />
        <ActiveTaskBar />
        <div className="flex flex-1 overflow-hidden">
          <main className="relative flex flex-1 flex-col overflow-y-auto">
            {/* Subtle ambient background */}
            <div className="pointer-events-none absolute inset-0 mesh-gradient opacity-50" />
            {/* `min-h-full` + flex column so a page that wants to fill the
                viewport (chat, editors) can just use `flex-1 min-h-0` instead of
                guessing a `calc(100dvh - Xrem)`. Those guesses are always wrong
                for someone: the header, the (conditional) ActiveTaskBar and this
                padding all vary, so a hardcoded offset either crops the page or
                leaves dead space. Ordinary pages are unaffected — a block child
                of a flex column still stretches to full width with auto height. */}
            <div className="relative flex min-h-full flex-col p-4 sm:p-6 lg:p-8">
              {children}
            </div>
          </main>
          {/* Right-side activity panel */}
          <ActivityPanel />
        </div>
      </div>
    </div>
  );
}
