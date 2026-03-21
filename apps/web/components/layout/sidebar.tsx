"use client";

import Link from "next/link";
import NextImage from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "~/lib/utils";
import { OrgSwitcher } from "~/components/layout/org-switcher";
import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  LayoutDashboard,
  Share2,
  Sparkles,
  Image,
  BarChart3,
  Users,
  Settings,
  CreditCard,
  Webhook,
  Key,
  FileText,
  Rss,
  Link2,
  CheckCircle,
  BookOpen,
  Zap,
  Newspaper,
} from "lucide-react";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Content Studio", href: "/dashboard/content-agent", icon: Sparkles },
  { name: "Channels", href: "/dashboard/channels", icon: Share2 },
  { name: "Media", href: "/dashboard/media", icon: Image },
  { name: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { name: "RSS Feeds", href: "/dashboard/rss", icon: Rss },
  { name: "Short Links", href: "/dashboard/links", icon: Link2 },
  { name: "NewsGrid Bot", href: "/dashboard/newsgrid", icon: Newspaper },
  { name: "Autopilot", href: "/dashboard/autopilot", icon: Zap },
  { name: "Approvals", href: "/dashboard/approvals", icon: CheckCircle },
  { name: "Team", href: "/dashboard/team", icon: Users },
];

const settingsNav = [
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
  { name: "Billing", href: "/dashboard/settings/billing", icon: CreditCard },
  { name: "Webhooks", href: "/dashboard/settings/webhooks", icon: Webhook },
  { name: "API Keys", href: "/dashboard/settings/api-keys", icon: Key },
  { name: "API Docs", href: "/dashboard/settings/api-docs", icon: BookOpen },
  { name: "Audit Log", href: "/dashboard/settings/audit-log", icon: FileText },
];

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();

  const handleNavClick = () => {
    if (onClose) onClose();
  };

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="flex h-16 items-center justify-between px-5">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <NextImage
            src="/logo.png"
            alt="PostAutomation"
            width={28}
            height={28}
            className="h-7 w-7"
          />
          <span className="text-[15px] font-semibold tracking-tight">
            PostAutomation
          </span>
        </Link>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 lg:hidden"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close sidebar</span>
        </Button>
      </div>

      {/* Organization Switcher */}
      <div className="mx-3 mb-1 rounded-xl border border-border/40 bg-background/30 p-1.5">
        <OrgSwitcher />
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
        <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          Main
        </div>
        {navigation.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={handleNavClick}
              className={cn(
                "group flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-medium transition-all",
                isActive
                  ? "bg-foreground/[0.06] text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
              )}
            >
              <item.icon
                className={cn(
                  "h-4 w-4 transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground/70 group-hover:text-foreground"
                )}
              />
              {item.name}
            </Link>
          );
        })}

        <div className="mb-2 mt-6 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          Settings
        </div>
        {settingsNav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={handleNavClick}
              className={cn(
                "group flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-medium transition-all",
                isActive
                  ? "bg-foreground/[0.06] text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
              )}
            >
              <item.icon
                className={cn(
                  "h-4 w-4 transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground/70 group-hover:text-foreground"
                )}
              />
              {item.name}
            </Link>
          );
        })}
      </nav>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden h-full w-[260px] flex-col border-r border-border/40 bg-card/50 backdrop-blur-xl lg:flex">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar overlay */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-border/40 bg-card shadow-2xl">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}
