"use client";

import { useState } from "react";
import { Sidebar } from "~/components/layout/sidebar";
import { Header } from "~/components/layout/header";
import { ActivityPanel, type ActivityCounts } from "~/components/layout/activity-panel";
import { ActiveTaskBar } from "~/components/layout/active-task-bar";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Design restyle: the activity feed is a header-toggled overlay, so its open
  // state and its alert counts live here, between the button and the panel.
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityCounts, setActivityCounts] = useState<ActivityCounts>({
    pending: 0,
    error: 0,
  });

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          onActivityClick={() => setActivityOpen((v) => !v)}
          activityOpen={activityOpen}
          activityCounts={activityCounts}
        />
        <ActiveTaskBar />
        <div className="flex flex-1 overflow-hidden">
          <main className="relative flex flex-1 flex-col overflow-y-auto">
            {/* Ambient gold mesh wash — already low-alpha, so no extra opacity */}
            <div className="mesh-gradient pointer-events-none absolute inset-0" />
            {/* `min-h-full` + flex column so a page that wants to fill the
                viewport (chat, editors) can just use `flex-1 min-h-0` instead of
                guessing a `calc(100dvh - Xrem)`. Those guesses are always wrong
                for someone: the header, the (conditional) ActiveTaskBar and this
                padding all vary, so a hardcoded offset either crops the page or
                leaves dead space. Ordinary pages are unaffected — a block child
                of a flex column still stretches to full width with auto height. */}
            {/* `shrink-0` is load-bearing: this is a flex item of the scrolling
                <main> column, so the default flex-shrink:1 clamped its box to the
                viewport height while its content overflowed. The padding-bottom
                then landed mid-content instead of after the last element, and
                every long page ended flush against the scroll edge looking cut
                off. With shrink-0 the box grows to its content and the bottom
                padding lands where it belongs. */}
            <div className="relative flex min-h-full shrink-0 flex-col p-4 sm:p-6 lg:p-8">

              {children}
            </div>
          </main>
          {/* Right-side activity panel — fixed overlay, opened from the header.
              Always mounted so its SSE connection and the counts driving the
              header's alert dot keep running while it is closed. */}
          <ActivityPanel
            open={activityOpen}
            onClose={() => setActivityOpen(false)}
            onCountsChange={setActivityCounts}
          />
        </div>
      </div>
    </div>
  );
}
