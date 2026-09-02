"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "~/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      /*
       * The design's segmented control track: `gap:4px; padding:4px;
       * border:1px solid var(--border); border-radius:11px;
       * background:var(--surface-1)`.
       *
       * The track is the DARKER surface (surface-1 = #000) and the active pill
       * is the LIGHTER one (tile = #0F0F0E) — see TabsTrigger. Stock shadcn had
       * these inverted (`bg-muted` track, `bg-background` active), so the
       * selected tab read as a hole punched in the track rather than a raised
       * pill. Do not swap them back.
       *
       * `h-auto` rather than a fixed `h-9`: at the design's `p-1` + `py-2` the
       * control is ~40px, and a hard 36px clipped the pills. Callers that pass
       * an explicit height still win.
       */
      "inline-flex h-auto items-center justify-center gap-1 rounded-[11px] border border-border bg-surface1 p-1 text-muted-foreground",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      /*
       * Active pill: `background:var(--tile)` + a 1px INSET ring in border-2 and
       * a weight bump to 600 — the design's whole "selected" signal. The inset
       * ring is used instead of a real border so the pill doesn't shift by 1px
       * when it becomes active. Flat: no drop `shadow`.
       */
      "inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-lg px-3 py-2 text-[12.5px] font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:text-foreground data-[state=active]:bg-tile data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_0_0_1px_hsl(var(--border-2))]",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
