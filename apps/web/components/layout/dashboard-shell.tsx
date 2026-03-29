"use client";

import { useState } from "react";
import { Sidebar } from "~/components/layout/sidebar";
import { Header } from "~/components/layout/header";
import { ActivityPanel } from "~/components/layout/activity-panel";
import { ActiveTaskBar } from "~/components/layout/active-task-bar";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onMenuClick={() => setSidebarOpen(true)} />
        <ActiveTaskBar />
        <div className="flex flex-1 overflow-hidden">
          <main className="relative flex-1 overflow-y-auto">
            {/* Subtle ambient background */}
            <div className="pointer-events-none absolute inset-0 mesh-gradient opacity-50" />
            <div className="relative p-4 sm:p-6 lg:p-8">
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
