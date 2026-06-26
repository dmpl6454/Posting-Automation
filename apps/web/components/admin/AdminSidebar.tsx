"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Building2,
  FileText,
  Radio,
  Bot,
  Image,
  Server,
  ScrollText,
  ArrowLeft,
  LogOut,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";

interface AdminSidebarProps {
  /** Mobile drawer open state. On lg+ the rail is always shown regardless. */
  open?: boolean;
  onClose?: () => void;
}

const navItems = [
  { label: "Overview", href: "/admin", icon: LayoutDashboard },
  { label: "Users", href: "/admin/users", icon: Users },
  { label: "Organizations", href: "/admin/orgs", icon: Building2 },
  { label: "Posts", href: "/admin/posts", icon: FileText },
  { label: "Channels", href: "/admin/channels", icon: Radio },
  { label: "Agents", href: "/admin/agents", icon: Bot },
  { label: "Media", href: "/admin/media", icon: Image },
  { label: "Queues", href: "/admin/queues", icon: Server },
  { label: "Audit Logs", href: "/admin/audit", icon: ScrollText },
];

export function AdminSidebar({ open = false, onClose }: AdminSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.replace("/admin/login");
  }

  return (
    <aside
      className={cn(
        "flex h-dvh w-60 flex-col bg-gray-950 transition-transform duration-200",
        // Mobile: fixed slide-in drawer over content. lg+: static in-flow rail.
        "fixed inset-y-0 left-0 z-40 lg:static lg:z-auto lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
      )}
    >
      {/* Logo */}
      <div className="flex items-center justify-between px-4 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-red-600 text-xs font-bold text-white">
            SA
          </div>
          <span className="text-sm font-semibold text-white">Super Admin</span>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-gray-400 hover:bg-gray-900 hover:text-gray-200 lg:hidden"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-2">
        {navItems.map((item) => {
          const isActive =
            item.href === "/admin"
              ? pathname === "/admin"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="border-t border-gray-800 p-3 space-y-1">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-400 hover:bg-gray-900 hover:text-gray-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-400 hover:bg-gray-900 hover:text-gray-200"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </div>
    </aside>
  );
}
