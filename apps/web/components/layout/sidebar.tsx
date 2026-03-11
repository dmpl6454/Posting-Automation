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
  PenSquare,
  CalendarDays,
  Share2,
  Sparkles,
  Bot,
  Image,
  ImagePlus,
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
  Repeat2,
  Layers,
  BookOpen,
} from "lucide-react";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Posts", href: "/dashboard/posts", icon: PenSquare },
  { name: "Calendar", href: "/dashboard/calendar", icon: CalendarDays },
  { name: "Channels", href: "/dashboard/channels", icon: Share2 },
  { name: "AI Studio", href: "/dashboard/ai", icon: Sparkles },
  { name: "AI Agents", href: "/dashboard/agents", icon: Bot },
  { name: "AI Repurpose", href: "/dashboard/ai/repurpose", icon: Repeat2 },
  { name: "Image Studio", href: "/dashboard/image-studio", icon: ImagePlus },
  { name: "Media", href: "/dashboard/media", icon: Image },
  { name: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { name: "RSS Feeds", href: "/dashboard/rss", icon: Rss },
  { name: "Short Links", href: "/dashboard/links", icon: Link2 },
  { name: "Approvals", href: "/dashboard/approvals", icon: CheckCircle },
  { name: "Bulk Ops", href: "/dashboard/posts/bulk", icon: Layers },
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
    // Close the mobile sidebar when a navigation link is clicked
    if (onClose) {
      onClose();
    }
  };

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="flex h-16 items-center justify-between border-b px-6">
        <Link href="/dashboard" className="flex items-center gap-2">
          <NextImage src="/logo.png" alt="PostAutomation" width={32} height={32} className="h-8 w-8" />
          <span className="text-lg font-bold">PostAutomation</span>
        </Link>
        {/* Close button — only visible on mobile */}
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onClose}
        >
          <X className="h-5 w-5" />
          <span className="sr-only">Close sidebar</span>
        </Button>
      </div>

      {/* Organization Switcher */}
      <div className="border-b px-3 py-3">
        <OrgSwitcher />
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        <div className="mb-2 px-3 text-xs font-semibold uppercase text-muted-foreground">
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
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}

        <div className="mb-2 mt-6 px-3 text-xs font-semibold uppercase text-muted-foreground">
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
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>
    </>
  );

  return (
    <>
      {/* Desktop sidebar — always visible at lg and above */}
      <aside className="hidden h-full w-64 flex-col border-r bg-card lg:flex">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar overlay */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50"
            onClick={onClose}
            aria-hidden="true"
          />
          {/* Sidebar drawer */}
          <aside className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-card shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}
