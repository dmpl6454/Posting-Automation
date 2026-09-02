"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "~/lib/utils";
import { ScrollableTabRow } from "~/components/ui/scrollable-tab-row";

const tabs = [
  { name: "Overview", href: "/dashboard/autopilot" },
  { name: "Agents", href: "/dashboard/autopilot/agents" },
  { name: "Trending", href: "/dashboard/autopilot/trending" },
  { name: "Review Queue", href: "/dashboard/autopilot/review" },
  { name: "Posts", href: "/dashboard/autopilot/posts" },
  { name: "Account Groups", href: "/dashboard/autopilot/accounts" },
  { name: "Pipeline Logs", href: "/dashboard/autopilot/logs" },
];

export default function AutopilotLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="space-y-6">
      {/* Page header — design pattern (eyebrow, display headline, sub). */}
      <div className="min-w-0">
        <span className="eyebrow">Autopilot</span>
        <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
          Discover, draft, review, post.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Autonomous content pipeline — from trending topics to published posts
        </p>
      </div>

      {/* Segmented pill row, matching the design's sub-tab treatment (the same
          one Content Studio uses) instead of the old underline row. The design
          hardcodes a 7-column grid, which is unusable on a phone — below `lg`
          this stays a horizontally scrollable row so every tab is reachable. */}
      <ScrollableTabRow
        role="tablist"
        className="gap-1 rounded-[11px] border border-border bg-surface1 p-1 lg:grid lg:grid-cols-7 lg:overflow-visible"
      >
        {tabs.map((tab) => {
          const isActive =
            tab.href === "/dashboard/autopilot"
              ? pathname === tab.href
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              role="tab"
              aria-selected={isActive}
              className={cn(
                // Design: 8px/4px pill, 11px label, gold fill + halo when active.
                "shrink-0 whitespace-nowrap rounded-[8px] px-3 py-2 text-center text-[11px] leading-[1.3] transition-colors lg:min-w-0 lg:px-1",
                isActive
                  ? "pa-gold-glow bg-gold font-semibold text-[hsl(var(--gold-foreground))]"
                  : "font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
              )}
            >
              <span className="block truncate">{tab.name}</span>
            </Link>
          );
        })}
      </ScrollableTabRow>

      <div>{children}</div>
    </div>
  );
}
