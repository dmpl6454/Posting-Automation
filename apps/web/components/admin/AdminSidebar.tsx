"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  LayoutDashboard,
  Users,
  UsersRound,
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
  { label: "Teams", href: "/admin/teams", icon: UsersRound },
  { label: "Posts", href: "/admin/posts", icon: FileText },
  { label: "Channels", href: "/admin/channels", icon: Radio },
  { label: "Agents", href: "/admin/agents", icon: Bot },
  { label: "Media", href: "/admin/media", icon: Image },
  { label: "Queues", href: "/admin/queues", icon: Server },
  { label: "Audit Logs", href: "/admin/audit", icon: ScrollText },
];

export function AdminSidebar({ open = false, onClose }: AdminSidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        "flex h-dvh w-60 flex-col border-r border-border bg-surface1 transition-transform duration-200",
        // Mobile: fixed slide-in drawer over content. lg+: static in-flow rail.
        "fixed inset-y-0 left-0 z-40 lg:static lg:z-auto lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
      )}
    >
      {/* Logo */}
      <div className="flex items-center justify-between px-4 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[#d9695f] text-[11px] font-bold leading-none text-white">
            SA
          </div>
          <span className="text-[14px] font-semibold leading-none">Super Admin</span>
        </div>
        <button
          onClick={onClose}
          className="rounded-[7px] p-1 text-muted-foreground hover:bg-hover hover:text-foreground lg:hidden"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex flex-1 flex-col gap-0.5 px-2">
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
                "flex items-center gap-[11px] rounded-[7px] px-[11px] py-[9px] text-[13px] font-medium leading-none transition-colors",
                isActive
                  ? "bg-gold/[0.12] text-gold"
                  : "text-muted-foreground hover:bg-hover hover:text-foreground"
              )}
            >
              <item.icon className="h-[15px] w-[15px] shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="flex flex-col gap-0.5 border-t border-border px-2 py-3">
        <Link
          href="/dashboard"
          className="flex items-center gap-[9px] rounded-[7px] px-[11px] py-[9px] text-[13px] font-medium leading-none text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <ArrowLeft className="h-[15px] w-[15px] shrink-0" />
          Back to Dashboard
        </Link>
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="flex w-full items-center gap-[9px] rounded-[7px] px-[11px] py-[9px] text-[13px] font-medium leading-none text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <LogOut className="h-[15px] w-[15px] shrink-0" />
          Logout
        </button>
      </div>
    </aside>
  );
}
