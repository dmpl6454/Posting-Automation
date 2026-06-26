"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Badge } from "~/components/ui/badge";

interface AdminHeaderProps {
  onMenuClick?: () => void;
}

const pageTitleMap: Record<string, string> = {
  "/admin": "Overview",
  "/admin/users": "Users",
  "/admin/orgs": "Organizations",
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
    <header className="flex h-14 items-center justify-between border-b bg-white px-4 sm:px-6">
      <div className="flex items-center gap-2">
        <button
          onClick={onMenuClick}
          className="rounded-md p-1.5 text-gray-600 hover:bg-gray-100 lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">{title}</h1>
      </div>
      <Badge className="bg-red-50 text-red-700 hover:bg-red-50">
        SUPER ADMIN
      </Badge>
    </header>
  );
}
