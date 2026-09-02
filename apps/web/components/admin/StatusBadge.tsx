import { cn } from "~/lib/utils";

/**
 * Status pill for the admin console.
 *
 * ⚠️ LITERAL HEX, NEVER TAILWIND SCALE CLASSES. This project's Tailwind config
 * flattens the gray/blue/yellow/orange/green/red/amber palettes onto the
 * palette's status HSL triplets, so the previous map (`bg-green-100
 * text-green-700`, etc.) rendered every pill as a label the SAME colour as its
 * own background — invisible text on every admin table that shows a status.
 *
 * The design tints the background to ~13% of the label colour and puts a 30%
 * border on it; that is what the `22` / `4d` alpha suffixes below do.
 */
const STATUS_COLOR: Record<string, string> = {
  // Post statuses
  DRAFT: "#8a8578",
  SCHEDULED: "#5b9bd5",
  QUEUED: "#e0b84a",
  PUBLISHING: "#e08a4a",
  PUBLISHED: "#5cb85c",
  FAILED: "#d9695f",

  // Token / expiry statuses
  valid: "#5cb85c",
  expiring: "#e0b84a",
  expired: "#d9695f",

};

/**
 * Plan tiers render as a NEUTRAL outline pill, not a coloured one — that is
 * what the admin design shows (PROFESSIONAL and STARTER look identical there,
 * bordered with light text). Colour is reserved for statuses, where it carries
 * meaning (failed vs published); a plan tier is a label, not a state.
 */
const PLAN_TIERS = new Set(["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]);

const DEFAULT_COLOR = "#8a8578";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const isPlan = PLAN_TIERS.has(status);
  const color = STATUS_COLOR[status] ?? DEFAULT_COLOR;

  return (
    <span
      className={cn(
        "inline-block whitespace-nowrap rounded-[6px] border px-2.5 py-[3px] text-[10.5px] font-semibold leading-[1.6]",
        isPlan && "border-border2 bg-transparent text-foreground/90",
        className
      )}
      style={
        isPlan
          ? undefined
          : { background: `${color}22`, color, borderColor: `${color}4d` }
      }
    >
      {status}
    </span>
  );
}
