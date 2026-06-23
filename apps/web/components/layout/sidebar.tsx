"use client";

import Link from "next/link";
import NextImage from "next/image";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { cn } from "~/lib/utils";
import { OrgSwitcher } from "~/components/layout/org-switcher";
import { trpc } from "~/lib/trpc/client";
import { X, Lock } from "lucide-react";
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
  // Newspaper, // NewsGrid Bot hidden from UI 2026-06-23 — re-add with the nav entry below
  Monitor,
  GitBranch,
  Ear,
  Target,
  Star,
} from "lucide-react";

type MemberRole = "OWNER" | "ADMIN" | "MEMBER";
type PlanType = "FREE" | "STARTER" | "PROFESSIONAL" | "ENTERPRISE";

const PLAN_ORDER: PlanType[] = ["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"];

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
  /** If set, only users with one of these roles see this item. Omit = everyone. */
  roles?: MemberRole[];
  /** If set, show a lock badge unless org plan meets this minimum. */
  minPlan?: PlanType;
}

const navigation: NavItem[] = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Super Agent", href: "/dashboard/super-agent", icon: Zap, minPlan: "STARTER" },
  { name: "Content Studio", href: "/dashboard/content-agent", icon: Sparkles },
  { name: "Channels", href: "/dashboard/channels", icon: Share2 },
  { name: "Media", href: "/dashboard/media", icon: Image },
  { name: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { name: "RSS Feeds", href: "/dashboard/rss", icon: Rss },
  { name: "Short Links", href: "/dashboard/links", icon: Link2 },
  // NewsGrid Bot hidden from UI 2026-06-23 — redundant with Repurpose (same render stack).
  // Route + newsgrid.router.ts kept intact; re-add this nav entry to restore.
  // { name: "NewsGrid Bot", href: "/dashboard/newsgrid", icon: Newspaper, minPlan: "STARTER" },
  { name: "Autopilot", href: "/dashboard/autopilot", icon: Zap, minPlan: "STARTER" },
  { name: "Social Listening", href: "/dashboard/listening", icon: Ear, minPlan: "STARTER" },
  { name: "Campaigns", href: "/dashboard/campaigns", icon: Target, minPlan: "PROFESSIONAL" },
  // Fix #62: sidebar label aligned with page header ("Brand Outreach")
  { name: "Brand Outreach", href: "/dashboard/brand-leads", icon: Star, minPlan: "PROFESSIONAL" },
  { name: "Approvals", href: "/dashboard/approvals", icon: CheckCircle },
  // Fix #1: Team visible to OWNER + ADMIN only
  { name: "Team", href: "/dashboard/team", icon: Users, roles: ["OWNER", "ADMIN"] },
  // Fix #1: Billing moved to main nav (was in settingsNav — caused double-highlight)
  { name: "Billing", href: "/dashboard/settings/billing", icon: CreditCard, roles: ["OWNER", "ADMIN"] },
];

const settingsNav: NavItem[] = [
  { name: "Monitoring", href: "/dashboard/monitoring", icon: Monitor },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
  // Fix #4: Billing removed from settingsNav (now lives in main nav above)
  { name: "Webhooks", href: "/dashboard/settings/webhooks", icon: Webhook, roles: ["OWNER", "ADMIN"] },
  { name: "API Keys", href: "/dashboard/settings/api-keys", icon: Key, roles: ["OWNER", "ADMIN"] },
  { name: "API Docs", href: "/dashboard/settings/api-docs", icon: BookOpen, roles: ["OWNER", "ADMIN"] },
  { name: "Audit Log", href: "/dashboard/settings/audit-log", icon: FileText, roles: ["OWNER", "ADMIN"] },
  { name: "Versions", href: "/dashboard/settings/versions", icon: GitBranch, roles: ["OWNER", "ADMIN"] },
];

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = (session?.user as any)?.role as MemberRole | undefined;
  const isSuperAdmin = (session?.user as any)?.isSuperAdmin === true;
  const { data: planData } = trpc.billing.currentPlan.useQuery(undefined, {
    // Refresh every 5 minutes — plan changes are low-frequency
    staleTime: 5 * 60 * 1000,
  });
  const orgPlan = (planData?.plan ?? "FREE") as PlanType;
  // Temporary: when billing is disabled, every feature is unlocked for everyone,
  // so no nav item should show a lock badge or redirect to billing.
  const billingDisabled = planData?.billingDisabled === true;

  /** Returns true if the org's current plan meets the item's minPlan requirement.
   *  Super admins always pass — they have unlimited access to all features. */
  const planAllowed = (item: NavItem) => {
    if (!item.minPlan) return true;
    if (billingDisabled) return true;
    if (isSuperAdmin) return true;
    return PLAN_ORDER.indexOf(orgPlan) >= PLAN_ORDER.indexOf(item.minPlan);
  };

  const handleNavClick = () => {
    if (onClose) onClose();
  };

  /** Filter items by role gate */
  const visible = (items: NavItem[]) =>
    items.filter((n) => !n.roles || (role && n.roles.includes(role)));

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
        {visible(navigation).map((item) => {
          // Fix #4: avoid double-highlight — Settings parent should not match
          // sub-routes via startsWith since Billing is now a top-level nav item.
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard/settings" &&
              item.href !== "/dashboard" &&
              pathname.startsWith(item.href + "/"));
          const locked = !planAllowed(item);
          return (
            <Link
              key={item.name}
              href={locked ? "/dashboard/settings/billing" : item.href}
              onClick={handleNavClick}
              className={cn(
                "group flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-medium transition-all",
                isActive && !locked
                  ? "bg-foreground/[0.06] text-foreground shadow-sm"
                  : locked
                  ? "text-muted-foreground/50 hover:bg-foreground/[0.04] hover:text-muted-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
              )}
            >
              <item.icon
                className={cn(
                  "h-4 w-4 transition-colors",
                  isActive && !locked
                    ? "text-foreground"
                    : "text-muted-foreground/70 group-hover:text-foreground"
                )}
              />
              <span className="flex-1">{item.name}</span>
              {locked && (
                <Lock className="h-3 w-3 shrink-0 text-muted-foreground/40" />
              )}
            </Link>
          );
        })}

        <div className="mb-2 mt-6 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          Settings
        </div>
        {visible(settingsNav).map((item) => {
          // Settings sub-pages: exact match only to prevent double-highlight
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

      {/* Version footer */}
      <div className="border-t border-border/40 px-4 py-2">
        <Link
          href="/dashboard/settings/versions"
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          <GitBranch className="h-3 w-3" />
          v{process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0-dev"}
        </Link>
      </div>
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
