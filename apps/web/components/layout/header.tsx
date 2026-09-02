"use client";

import { useSession, signOut } from "next-auth/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Button } from "~/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { LogOut, User, Settings, Menu, ShieldCheck, ChevronDown, Activity } from "lucide-react";
import Link from "next/link";
import { cn } from "~/lib/utils";
import { NotificationBell } from "~/components/notifications/notification-bell";
import { ThemeToggle } from "~/components/layout/theme-toggle";

interface HeaderProps {
  onMenuClick?: () => void;
  /** Design restyle: the activity feed is opened from here, not a side rail. */
  onActivityClick?: () => void;
  activityOpen?: boolean;
  activityCounts?: { pending: number; error: number };
}

export function Header({
  onMenuClick,
  onActivityClick,
  activityOpen,
  activityCounts,
}: HeaderProps) {
  const { data: session } = useSession();

  const initials = session?.user?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "U";

  // App-level RBAC pill (2026-07-17): make the current access tier visible at a
  // glance. Super admin implies Admin at every gate; label it distinctly.
  const hasActivityAlert =
    (activityCounts?.pending ?? 0) > 0 || (activityCounts?.error ?? 0) > 0;

  const isSuperAdmin = (session?.user as any)?.isSuperAdmin === true;
  const appRole = (session?.user as any)?.appRole as "USER" | "ADMIN" | undefined;
  const roleLabel = isSuperAdmin ? "Super Admin" : appRole === "ADMIN" ? "Admin" : "User";
  // Design restyle: the tier reads as an uppercase micro-label under the name
  // rather than a coloured pill. Super admin keeps a gold tint so the highest
  // privilege level is still distinguishable at a glance.
  const roleLabelClass = isSuperAdmin
    ? "text-gold"
    : "text-muted-foreground";
  // Design: accent-tinted pill for super admin, neutral tile pill otherwise.
  const rolePillClass = isSuperAdmin
    ? "border-[hsl(var(--accent-border))] bg-gold/[0.12] text-gold"
    : "border-border2 bg-tile text-muted-foreground";

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-surface1 px-4 sm:px-5">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 lg:hidden"
          onClick={onMenuClick}
        >
          <Menu className="h-4 w-4" />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </div>

      <div className="flex items-center gap-2.5">
        {/* Theme Toggle */}
        <ThemeToggle />

        {/* Activity feed — design restyle: lives in the header, matching the
            32px bordered icon set. Desktop only, mirroring the panel it opens. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onActivityClick}
          aria-pressed={activityOpen}
          title="Activity feed"
          className={cn(
            "relative hidden h-8 w-8 rounded-[9px] border border-border text-muted-foreground hover:bg-hover hover:text-foreground lg:inline-flex",
            activityOpen && "bg-tile text-foreground"
          )}
        >
          <Activity className="h-[15px] w-[15px]" />
          {hasActivityAlert && (
            <span
              className={cn(
                "absolute -right-[2px] -top-[2px] h-[7px] w-[7px] rounded-full border-2 border-background",
                (activityCounts?.error ?? 0) > 0 ? "bg-destructive" : "bg-gold"
              )}
            />
          )}
          <span className="sr-only">Activity feed</span>
        </Button>

        {/* Notifications */}
        <NotificationBell />

        {/* Divider — design restyle */}
        <span className="mx-0.5 hidden h-6 w-px bg-border sm:block" />

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex h-auto items-center gap-[9px] rounded-lg px-1.5 py-1 hover:bg-hover"
            >
              <Avatar className="h-7 w-7 rounded-lg">
                <AvatarImage src={session?.user?.image || undefined} />
                <AvatarFallback className="rounded-lg bg-tile text-[10px] font-semibold text-muted-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="hidden text-left sm:block">
                <span className="block max-w-[110px] truncate text-[12px] font-semibold leading-[1.3]">
                  {session?.user?.name || "User"}
                </span>
                {session?.user && (
                  <span
                    className={`block text-[8.5px] font-medium uppercase leading-[1.3] tracking-[0.14em] ${roleLabelClass}`}
                    title="Your access level. Admins manage all feature areas; Users get Dashboard, Content Studio, Super Agent, Media, Insights and Channels."
                  >
                    {roleLabel}
                  </span>
                )}
              </span>
              <ChevronDown className="hidden h-3 w-3 text-muted-foreground sm:block" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-48 rounded-lg border-border bg-surface2 p-1 shadow-lg"
          >
            {session?.user && (
              <>
                <div className="px-2.5 py-2 text-[11.5px] leading-[1.4] text-muted-foreground">
                  Access:{" "}
                  <span className={`ml-[3px] rounded-full border px-2 py-[1.5px] text-[10px] font-medium leading-[1.6] ${rolePillClass}`}>
                    {roleLabel}
                  </span>
                </div>
                <DropdownMenuSeparator className="bg-border" />
              </>
            )}
            <DropdownMenuItem asChild className="rounded-[7px] px-2.5 py-2 text-[12px] font-medium leading-none">
              <Link href="/dashboard/settings" className="cursor-pointer">
                <User className="mr-2 h-[13px] w-[13px]" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="rounded-[7px] px-2.5 py-2 text-[12px] font-medium leading-none">
              <Link href="/dashboard/settings" className="cursor-pointer">
                <Settings className="mr-2 h-[13px] w-[13px]" />
                Settings
              </Link>
            </DropdownMenuItem>
            {isSuperAdmin && (
              <DropdownMenuItem asChild className="rounded-[7px] px-2.5 py-2 text-[12px] font-medium leading-none">
                <Link href="/admin/users" className="cursor-pointer">
                  <ShieldCheck className="mr-2 h-[13px] w-[13px]" />
                  Manage access roles
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              className="cursor-pointer rounded-[7px] px-2.5 py-2 text-[12px] font-medium leading-none text-destructive focus:text-destructive"
              onClick={() => signOut({ callbackUrl: "/" })}
            >
              <LogOut className="mr-2 h-[13px] w-[13px]" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
