"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

interface AdminHeaderProps {
  onMenuClick?: () => void;
}

const pageTitleMap: Record<string, string> = {
  "/admin": "Overview",
  "/admin/users": "Users",
  "/admin/orgs": "Organizations",
  // Teams was missing, so /admin/teams fell through to the generic "Admin".
  "/admin/teams": "Teams",
  "/admin/posts": "Posts",
  "/admin/channels": "Channels",
  "/admin/agents": "Agents",
  "/admin/media": "Media",
  "/admin/queues": "Queues",
  "/admin/audit": "Audit Logs",
};

export function AdminHeader({ onMenuClick }: AdminHeaderProps) {
  const pathname = usePathname();

  const title =
    pageTitleMap[pathname] ??
    Object.entries(pageTitleMap).find(([key]) =>
      pathname.startsWith(key) && key !== "/admin"
    )?.[1] ??
    "Admin";

  return (
    /* Design: a 56px surface-1 bar, 24px gutters, 17px/600 title, and the
       SUPER ADMIN chip in the design's red at 12% on a 40% border — not the
       shadcn Badge's light `bg-red-50`, which was a white pill on a dark bar. */
    <header className="flex h-14 items-center justify-between border-b border-border bg-surface1 px-4 sm:px-6">
      <div className="flex items-center gap-2">
        <button
          onClick={onMenuClick}
          className="rounded-[7px] p-1.5 text-muted-foreground hover:bg-hover hover:text-foreground lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="text-[17px] font-semibold leading-none">{title}</h1>
      </div>
      <span className="whitespace-nowrap rounded-[6px] border border-[rgba(217,105,95,0.4)] bg-[rgba(217,105,95,0.12)] px-[11px] py-[3px] text-[11px] font-bold leading-[1.8] tracking-[0.03em] text-[#d9695f]">
        SUPER ADMIN
      </span>
    </header>
  );
}
