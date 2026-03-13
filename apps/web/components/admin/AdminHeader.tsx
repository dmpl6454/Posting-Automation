"use client";

import { usePathname } from "next/navigation";
import { Badge } from "~/components/ui/badge";

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

export function AdminHeader() {
  const pathname = usePathname();

  const title =
    pageTitleMap[pathname] ??
    Object.entries(pageTitleMap).find(([key]) =>
      pathname.startsWith(key) && key !== "/admin"
    )?.[1] ??
    "Admin";

  return (
    <header className="flex h-14 items-center justify-between border-b bg-white px-6">
      <h1 className="text-lg font-semibold">{title}</h1>
      <Badge className="bg-red-50 text-red-700 hover:bg-red-50">
        SUPER ADMIN
      </Badge>
    </header>
  );
}
