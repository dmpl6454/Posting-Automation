import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

/*
 * Design button chrome: `border-radius:8-9px; height:36px; font:500-600 12.5px`,
 * and completely FLAT (no shadows anywhere — see card.tsx).
 * `rounded-md` already resolves to 8px via `calc(var(--radius) - 2px)`.
 *
 * Variant hierarchy, deliberately three deep (globals.css `.pa-cta-gold`
 * documents the same ladder):
 *   header primary  → `.pa-cta-gold` (gold fill; opt-in class, not a variant)
 *   in-card action  → `default`  (bone fill, `--primary` IS the bone)
 *   tertiary        → `outline` / `secondary` (card fill + border-2 hairline)
 *
 * `outline` fills with `bg-card`, NOT `bg-background`: the page background is
 * pure black, so a background-filled button was invisible except for its
 * hairline. The design's own secondary button is `background:var(--card)`.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary font-semibold text-primary-foreground hover:opacity-[0.88]",
        destructive:
          "bg-destructive font-semibold text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-card hover:border-border2 hover:bg-hover hover:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-hover",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
