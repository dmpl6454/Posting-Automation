import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

/*
 * Design badge (`.pa-badge` in globals.css is the hand-rolled twin):
 * `border:1px solid var(--border-2); border-radius:999px; padding:2px 8px;
 * font:500 10.5px/1.5`. The PILL shape is the signature — the design has no
 * rounded-rectangle badges anywhere. Flat, so no `shadow` on the fills.
 *
 * `outline` gets `border-border2` explicitly rather than leaning on the global
 * `* { @apply border-border }` fallback, which is a step too faint to read as
 * an outlined badge on a card.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[10.5px] font-medium leading-[1.5] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-border2 bg-tile text-secondary-foreground hover:bg-hover",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "border-border2 bg-tile text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
