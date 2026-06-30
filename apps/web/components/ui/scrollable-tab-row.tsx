"use client";

import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Horizontal, swipe-scrollable row for tab/segment strips so extra tabs are
 * reachable on narrow screens instead of being clipped by an overflow-hidden
 * ancestor. Scrollbar is visually hidden (utility in globals.css).
 * Context-agnostic: pass `role="tablist"` (for custom button strips) and any
 * border-collapse class (e.g. `-mb-px`) via props/className at the call site.
 */
export function ScrollableTabRow({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex overflow-x-auto whitespace-nowrap scrollbar-hide",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
