"use client";

import { cn } from "~/lib/utils";

/**
 * Horizontal, swipe-scrollable row for tab/segment strips so extra tabs are
 * reachable on narrow screens instead of being clipped by an overflow-hidden
 * ancestor. Scrollbar is visually hidden (utility added in globals.css).
 * Drop-in: replace the offending `<div className="flex border-b ...">` wrapper.
 */
export function ScrollableTabRow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex overflow-x-auto whitespace-nowrap scrollbar-hide -mb-px",
        className,
      )}
      role="tablist"
    >
      {children}
    </div>
  );
}
