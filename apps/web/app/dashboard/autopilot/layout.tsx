"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "~/lib/utils";

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
      <div>
        <h1 className="text-2xl font-bold">Autopilot</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Automated content pipeline powered by trending topics
        </p>
      </div>

      <nav className="flex gap-1 border-b">
        {tabs.map((tab) => {
          const isActive =
            tab.href === "/dashboard/autopilot"
              ? pathname === tab.href
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.name}
            </Link>
          );
        })}
      </nav>

      <div>{children}</div>
    </div>
  );
}
