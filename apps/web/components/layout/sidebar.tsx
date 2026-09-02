"use client";

import Link from "next/link";
import NextImage from "next/image";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { cn } from "~/lib/utils";
import { OrgSwitcher } from "~/components/layout/org-switcher";
import { trpc } from "~/lib/trpc/client";
import { X, Lock, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
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
  /** If set, only users with one of these ORG roles see this item. Omit = everyone. */
  roles?: MemberRole[];
  /** If set, show a lock badge unless org plan meets this minimum. */
  minPlan?: PlanType;
  /** App-level RBAC (User.appRole): only ADMIN-role (or super admin) users see this. */
  appAdminOnly?: boolean;
  /** Only isSuperAdmin users see this (e.g. Monitoring — its data is superAdminProcedure-only). */
  superAdminOnly?: boolean;
}

const navigation: NavItem[] = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Super Agent", href: "/dashboard/super-agent", icon: Zap, minPlan: "STARTER" },
  { name: "Content Studio", href: "/dashboard/content-agent", icon: Sparkles },
  { name: "Channels", href: "/dashboard/channels", icon: Share2 },
  { name: "Media", href: "/dashboard/media", icon: Image },
  { name: "Insights", href: "/dashboard/analytics", icon: BarChart3 },
  { name: "RSS Feeds", href: "/dashboard/rss", icon: Rss, appAdminOnly: true },
  { name: "Short Links", href: "/dashboard/links", icon: Link2, appAdminOnly: true },
  // NewsGrid Bot hidden from UI 2026-06-23 — redundant with Repurpose (same render stack).
  // Route + newsgrid.router.ts kept intact; re-add this nav entry to restore.
  // { name: "NewsGrid Bot", href: "/dashboard/newsgrid", icon: Newspaper, minPlan: "STARTER" },
  { name: "Autopilot", href: "/dashboard/autopilot", icon: Zap, minPlan: "STARTER", appAdminOnly: true },
  { name: "Social Listening", href: "/dashboard/listening", icon: Ear, minPlan: "STARTER", appAdminOnly: true },
  { name: "Campaigns", href: "/dashboard/campaigns", icon: Target, minPlan: "PROFESSIONAL", appAdminOnly: true },
  // Fix #62: sidebar label aligned with page header ("Brand Outreach")
  { name: "Brand Outreach", href: "/dashboard/brand-leads", icon: Star, minPlan: "PROFESSIONAL", appAdminOnly: true },
  { name: "Approvals", href: "/dashboard/approvals", icon: CheckCircle, appAdminOnly: true },
  // Fix #1: Team visible to OWNER + ADMIN only
  { name: "Team", href: "/dashboard/team", icon: Users, roles: ["OWNER", "ADMIN"], appAdminOnly: true },
  // Fix #1: Billing moved to main nav (was in settingsNav — caused double-highlight)
  { name: "Billing", href: "/dashboard/settings/billing", icon: CreditCard, roles: ["OWNER", "ADMIN"], appAdminOnly: true },
];

const settingsNav: NavItem[] = [
  // RBAC 2026-07-17: Monitoring's data is superAdminProcedure-only — it used to
  // be visible to EVERYONE (non-super-admins saw a shell of FORBIDDEN errors).
  { name: "Monitoring", href: "/dashboard/monitoring", icon: Monitor, superAdminOnly: true },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
  // Fix #4: Billing removed from settingsNav (now lives in main nav above)
  { name: "Webhooks", href: "/dashboard/settings/webhooks", icon: Webhook, roles: ["OWNER", "ADMIN"], appAdminOnly: true },
  { name: "API Keys", href: "/dashboard/settings/api-keys", icon: Key, roles: ["OWNER", "ADMIN"], appAdminOnly: true },
  { name: "API Docs", href: "/dashboard/settings/api-docs", icon: BookOpen, roles: ["OWNER", "ADMIN"], appAdminOnly: true },
  { name: "Audit Log", href: "/dashboard/settings/audit-log", icon: FileText, roles: ["OWNER", "ADMIN"], appAdminOnly: true },
  { name: "Versions", href: "/dashboard/settings/versions", icon: GitBranch, roles: ["OWNER", "ADMIN"], appAdminOnly: true },
];

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}


/**
 * Stale-bundle detector. An SPA tab keeps executing the JavaScript it loaded
 * until a REAL reload — which has repeatedly meant users reproducing bugs that
 * were already fixed on the server (2026-07-21: three video-upload crash
 * reports, each from a tab still running the previous bundle). Polls the
 * running server's /api/version and offers a one-click reload when it differs
 * from the version this bundle was built with. Reload is user-initiated only:
 * an auto-reload could kill an in-flight upload (the beforeunload guard would
 * prompt, but we never want to trigger that ourselves).
 */
function UpdateAvailableNotice() {
  const builtVersion = process.env.NEXT_PUBLIC_APP_VERSION || "";
  const [liveVersion, setLiveVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!builtVersion) return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { version?: string };
        if (!stopped && data.version && data.version !== builtVersion) {
          setLiveVersion(data.version);
        }
      } catch {
        // network blip — the next poll retries
      }
    };
    void check();
    const id = setInterval(check, 10 * 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [builtVersion]);

  if (!liveVersion) return null;
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="mx-4 mb-2 flex items-center gap-1.5 rounded-md border border-amber-300/60 bg-amber-50 px-2.5 py-1.5 text-left text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/70"
    >
      <RefreshCw className="h-3 w-3 flex-shrink-0" />
      Update available (v{liveVersion}) — click to refresh
    </button>
  );
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = (session?.user as any)?.role as MemberRole | undefined;
  const isSuperAdmin = (session?.user as any)?.isSuperAdmin === true;
  // App-level RBAC tier (separate from the org `role` above). Super admin implies admin.
  const appRole = (session?.user as any)?.appRole as "USER" | "ADMIN" | undefined;
  const isAppAdminUser = appRole === "ADMIN" || isSuperAdmin;
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

  /** Filter items by org-role, app-role (RBAC), and super-admin gates */
  const visible = (items: NavItem[]) =>
    items.filter((n) => {
      if (n.superAdminOnly && !isSuperAdmin) return false;
      if (n.appAdminOnly && !isAppAdminUser) return false;
      return !n.roles || (role && n.roles.includes(role));
    });

  const sidebarContent = (
    <>
      {/* Logo — design restyle: uppercase wordmark with wide tracking */}
      <div className="flex h-16 items-center justify-between px-5">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <NextImage
            src="/logo.png"
            alt="PostAutomation"
            width={26}
            height={26}
            className="h-[26px] w-[26px] rounded-md"
          />
          <span className="text-[12px] font-semibold uppercase leading-none tracking-[0.16em]">
            Postautomation
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
      <div className="mx-3 mb-1 rounded-lg border border-border bg-surface2 p-1.5">
        <OrgSwitcher />
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
        <div className="mb-2.5 flex items-center gap-2.5 px-3">
          <span className="text-[9px] font-medium uppercase leading-none tracking-[0.2em] text-muted-foreground">
            Main
          </span>
          <span className="h-px flex-1 bg-border" />
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
                "group flex items-center gap-[11px] rounded-lg px-3 py-[7px] text-[12.5px] transition-all",
                isActive && !locked
                  ? "bg-tile font-medium text-foreground"
                  : locked
                  ? "font-normal text-muted-foreground/50 hover:bg-hover hover:text-muted-foreground"
                  : "font-normal text-muted-foreground hover:bg-hover hover:text-foreground"
              )}
            >
              <span
                className={cn(
                  "pa-nav-icon",
                  isActive && !locked && "pa-nav-icon-active"
                )}
              >
                <item.icon
                  className={cn(
                    "h-4 w-4 shrink-0 transition-colors",
                    isActive && !locked
                      ? "text-foreground"
                      : "text-muted-foreground/70 group-hover:text-foreground"
                  )}
                />
              </span>
              <span className="flex-1">{item.name}</span>
              {locked ? (
                <Lock className="h-3 w-3 shrink-0 text-muted-foreground/40" />
              ) : isActive ? (
                <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-gold" />
              ) : null}
            </Link>
          );
        })}

        <div className="mb-2.5 mt-6 flex items-center gap-2.5 px-3">
          <span className="text-[9px] font-medium uppercase leading-none tracking-[0.2em] text-muted-foreground">
            Settings
          </span>
          <span className="h-px flex-1 bg-border" />
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
                "group flex items-center gap-[11px] rounded-lg px-3 py-[7px] text-[12.5px] transition-all",
                isActive
                  ? "bg-tile font-medium text-foreground"
                  : "font-normal text-muted-foreground hover:bg-hover hover:text-foreground"
              )}
            >
              <span className={cn("pa-nav-icon", isActive && "pa-nav-icon-active")}>
                <item.icon
                  className={cn(
                    "h-4 w-4 shrink-0 transition-colors",
                    isActive
                      ? "text-foreground"
                      : "text-muted-foreground/70 group-hover:text-foreground"
                  )}
                />
              </span>
              <span className="flex-1">{item.name}</span>
              {isActive && (
                <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-gold" />
              )}
            </Link>
          );
        })}
      </nav>

      <UpdateAvailableNotice />
      {/* Version footer */}
      <div className="border-t border-border px-4 py-2">
        <Link
          href="/dashboard/settings/versions"
          className="flex items-center gap-1.5 text-[11px] text-faint transition-colors hover:text-muted-foreground"
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
      <aside className="hidden h-full w-[260px] flex-col border-r border-border bg-surface1 lg:flex">
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
