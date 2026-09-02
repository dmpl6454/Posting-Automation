import * as React from "react";
import { cn } from "~/lib/utils";

/*
 * The design's card: `border:1px solid var(--border); border-radius:14px;
 * background:var(--card)` and NOTHING else. `rounded-xl` already resolves to
 * 14px (`calc(var(--radius) + 4px)`, --radius: 10px).
 *
 * NO shadow — the palette's first rule is "surfaces are FLAT; hairline borders
 * do the separating, never shadows". A drop shadow on true black also just
 * reads as a smudge. Do not re-add `shadow`.
 */
const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-xl border border-border bg-card text-card-foreground",
      className
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    /* Design: the sub-heading sits 5px under the title, not 6px. */
    className={cn("flex flex-col space-y-[5px] p-6", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    /*
     * Design card heading: `font:500 15px/1.2`. Stock shadcn was
     * `font-semibold` + `leading-none`, and 44 of the 84 call sites also
     * pushed it to `text-base` (16px/600) — noticeably heavier and larger than
     * every card heading in the design. The redundant `text-base` was stripped
     * from those call sites so this base actually applies.
     */
    className={cn("text-[15px] font-medium leading-[1.2] tracking-tight", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    /*
     * Design card sub-heading: `font:400 12px/1.4`. Stock shadcn was `text-sm`
     * (14px), which is what still made every card description read two sizes
     * larger than the design even after CardTitle had been ported — the same
     * miss, one line lower.
     */
    className={cn("text-[12px] leading-[1.4] text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
};
