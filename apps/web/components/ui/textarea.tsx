import * as React from "react";
import { cn } from "~/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        /*
         * Design: `border:1px solid var(--border-2); border-radius:8px;
         * background:var(--app-bg); padding:12px 13px; font:400 13px/1.65`.
         * Recessed to pure black for the same reason as Input — see input.tsx.
         * Flat: no `shadow-sm`.
         */
        "flex min-h-[60px] w-full rounded-md border border-input bg-background px-[13px] py-3 text-[13px] leading-[1.65] placeholder:text-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
