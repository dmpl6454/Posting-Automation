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
import { LogOut, User, Settings, Menu } from "lucide-react";
import Link from "next/link";
import { NotificationBell } from "~/components/notifications/notification-bell";
import { ThemeToggle } from "~/components/layout/theme-toggle";

interface HeaderProps {
  onMenuClick?: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const { data: session } = useSession();

  const initials = session?.user?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "U";

  return (
    <header className="flex h-14 items-center justify-between border-b border-border/40 bg-card/50 px-4 backdrop-blur-xl sm:px-6">
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

      <div className="flex items-center gap-1.5 sm:gap-2">
        {/* Theme Toggle */}
        <ThemeToggle />

        {/* Notifications */}
        <NotificationBell />

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex items-center gap-2 rounded-lg px-1.5 hover:bg-foreground/[0.04]"
            >
              <Avatar className="h-7 w-7">
                <AvatarImage src={session?.user?.image || undefined} />
                <AvatarFallback className="bg-foreground/[0.06] text-[10px] font-medium">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="hidden max-w-[100px] truncate text-[13px] font-medium sm:inline">
                {session?.user?.name || "User"}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-48 rounded-xl border-border/40 bg-card/95 p-1 shadow-lg backdrop-blur-xl"
          >
            <DropdownMenuItem asChild className="rounded-lg">
              <Link href="/dashboard/settings" className="cursor-pointer">
                <User className="mr-2 h-3.5 w-3.5" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="rounded-lg">
              <Link href="/dashboard/settings" className="cursor-pointer">
                <Settings className="mr-2 h-3.5 w-3.5" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-border/40" />
            <DropdownMenuItem
              className="cursor-pointer rounded-lg text-destructive focus:text-destructive"
              onClick={() => signOut({ callbackUrl: "/" })}
            >
              <LogOut className="mr-2 h-3.5 w-3.5" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
