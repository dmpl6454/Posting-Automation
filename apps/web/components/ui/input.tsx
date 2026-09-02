import * as React from "react";
import { cn } from "~/lib/utils";

const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        /*
         * The design's field: `height:38px; border:1px solid var(--border-2);
         * border-radius:8px; background:var(--app-bg); padding:0 12px;
         * font:400 12.5px`. `rounded-md` is 8px and `border-input` IS border-2.
         *
         * `bg-background` (not `bg-transparent`) is the load-bearing part: a
         * field sits on a #0A0A09 card, and the design recesses it to pure
         * black so the input reads as carved in rather than painted on.
         * Transparent made every field invisible except for its hairline.
         * Flat — no `shadow-sm`.
         */
        "flex h-[38px] w-full rounded-md border border-input bg-background px-3 py-1 text-[12.5px] transition-colors file:border-0 file:bg-transparent file:text-[12.5px] file:font-medium file:text-foreground placeholder:text-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
