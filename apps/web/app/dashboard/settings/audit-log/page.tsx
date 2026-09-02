"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { Fragment, useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Info,
} from "lucide-react";

/* Design tokens for this page (see the Settings page for why these are local
   rather than shared helpers). */
const FIELD_36 =
  "h-9 rounded-[8px] border-border2 bg-background px-3 text-[12px]";
const OUTLINE_BTN =
  "h-9 shrink-0 gap-1.5 rounded-[8px] border-border2 px-[15px] text-[12px] font-medium hover:bg-hover";

/* Action categories for color-coding.
   Literal hex, NOT Tailwind scale classes: this project's Tailwind config
   flattens emerald/red/blue/amber/slate onto the palette's status triplets, so
   `bg-emerald-100 text-emerald-800` rendered every one of these pills as a
   label the same colour as its own background. The design tints the background
   at ~13% of the label colour, which is what the `22` alpha suffix does. */
const ACTION_COLORS: Record<string, string> = {
  created: "#5cb85c",
  connected: "#5cb85c",
  invited: "#5cb85c",
  deleted: "#d9695f",
  removed: "#d9695f",
  disconnected: "#d9695f",
  cancelled: "#d9695f",
  updated: "#5b9bd5",
  changed: "#5b9bd5",
  refreshed: "#5b9bd5",
  scheduled: "#e0b84a",
  login: "#8a8578",
};
const ACTION_FALLBACK = "#8a8578";

/** Returns the pill's label colour; the background is that colour at 13%. */
function getActionColor(action: string): string {
  const actionPart = action.split(".").pop() || "";
  // `published` follows the workspace accent, so it has no fixed hex.
  if (actionPart === "published") return "";
  return ACTION_COLORS[actionPart] || ACTION_FALLBACK;
}

function formatAction(action: string): string {
  return action
    .split(".")
    .map((part: string) => part.replace(/_/g, " "))
    .join(" / ");
}

function formatDate(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// All possible action values for the filter dropdown
const ALL_ACTIONS = [
  { value: "post.created", label: "Post Created" },
  { value: "post.updated", label: "Post Updated" },
  { value: "post.deleted", label: "Post Deleted" },
  { value: "post.published", label: "Post Published" },
  { value: "post.scheduled", label: "Post Scheduled" },
  { value: "channel.connected", label: "Channel Connected" },
  { value: "channel.disconnected", label: "Channel Disconnected" },
  { value: "channel.refreshed", label: "Channel Refreshed" },
  { value: "member.invited", label: "Member Invited" },
  { value: "member.removed", label: "Member Removed" },
  { value: "member.role_changed", label: "Member Role Changed" },
  { value: "apikey.created", label: "API Key Created" },
  { value: "apikey.deleted", label: "API Key Deleted" },
  { value: "webhook.created", label: "Webhook Created" },
  { value: "webhook.updated", label: "Webhook Updated" },
  { value: "webhook.deleted", label: "Webhook Deleted" },
  { value: "billing.plan_changed", label: "Plan Changed" },
  { value: "billing.subscription_cancelled", label: "Subscription Cancelled" },
  { value: "org.settings_updated", label: "Org Settings Updated" },
  { value: "auth.login", label: "User Login" },
];

const ALL_ENTITY_TYPES = [
  { value: "Post", label: "Post" },
  { value: "Channel", label: "Channel" },
  { value: "OrganizationMember", label: "Team Member" },
  { value: "ApiKey", label: "API Key" },
  { value: "Webhook", label: "Webhook" },
  { value: "Organization", label: "Organization" },
];

function AuditLogPageInner() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<string>("");
  const [entityType, setEntityType] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // Which date field is focused — drives the text→date input swap below.
  const [dateFocus, setDateFocus] = useState<"from" | "to" | null>(null);
  // Fix #77: copy-to-clipboard state for entity IDs
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyEntityId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const { data, isLoading } = trpc.audit.list.useQuery({
    page,
    limit: 25,
    action: action || undefined,
    entityType: entityType || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
  });

  const resetFilters = () => {
    setAction("");
    setEntityType("");
    setStartDate("");
    setEndDate("");
    setPage(1);
  };

  const hasActiveFilters = action || entityType || startDate || endDate;

  return (
    /* Design stacks sections on 20px, not 24px. */
    <div className="w-full space-y-5">
      {/* Page header — eyebrow / display title / subtitle (design restyle) */}
      <div className="min-w-0">
        <span className="eyebrow">Audit Log</span>
        <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
          Every action, on record.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Track all actions and changes across your organization
        </p>
      </div>

      {/* Design: a quiet surface-1 note, not the Alert component's framing. */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
        <Info className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
        <p className="text-[12px] leading-[1.65] text-muted-foreground">
          Every significant action — invites, role changes, channel connects, billing events,
          webhook changes, password updates — is recorded with actor, timestamp, IP, and target.
          Entries are immutable; use the filters to narrow by user, action, or date.
        </p>
      </div>

      {/* Filters — the design has four bare inline controls, always visible.
          The old collapsible "Filters" card hid them behind a chevron and cost
          a whole card of vertical space above the log itself. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Select
          value={action}
          onValueChange={(val: string) => {
            setAction(val === "__all__" ? "" : val);
            setPage(1);
          }}
        >
          <SelectTrigger className={`${FIELD_36} w-[170px]`} aria-label="Filter by action">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All actions</SelectItem>
            {ALL_ACTIONS.map((a: any) => (
              <SelectItem key={a.value} value={a.value}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={entityType}
          onValueChange={(val: string) => {
            setEntityType(val === "__all__" ? "" : val);
            setPage(1);
          }}
        >
          <SelectTrigger className={`${FIELD_36} w-[150px]`} aria-label="Filter by entity type">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All types</SelectItem>
            {ALL_ENTITY_TYPES.map((et: any) => (
              <SelectItem key={et.value} value={et.value}>
                {et.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* The design labels these "From date" / "To date". A native date
            input ignores `placeholder` and always renders `dd-mm-yyyy`, so
            each field stays type=text until it is focused or holds a value.
            The swap is driven by STATE, not by mutating `e.target.type` —
            React re-renders from the `type` prop and would immediately undo a
            direct DOM write (measured: the field stayed `text` on focus). */}
        <Input
          type={dateFocus === "from" || startDate ? "date" : "text"}
          placeholder="From date"
          aria-label="From date"
          value={startDate}
          onFocus={() => setDateFocus("from")}
          onBlur={() => setDateFocus(null)}
          onChange={(e: any) => {
            setStartDate(e.target.value);
            setPage(1);
          }}
          className={`${FIELD_36} w-[130px]`}
        />
        <Input
          type={dateFocus === "to" || endDate ? "date" : "text"}
          placeholder="To date"
          aria-label="To date"
          value={endDate}
          onFocus={() => setDateFocus("to")}
          onBlur={() => setDateFocus(null)}
          onChange={(e: any) => {
            setEndDate(e.target.value);
            setPage(1);
          }}
          className={`${FIELD_36} w-[130px]`}
        />

        {/* Not in the design, but without it an active filter has no exit. */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            onClick={resetFilters}
            className="h-9 rounded-[8px] px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            Clear all
          </Button>
        )}
      </div>

      {/* The event count the old card header carried — kept as a quiet line,
          since the design's list card has no header at all. */}
      {data && (
        <p className="-mb-1 text-[11.5px] leading-none text-faint">
          {data.total} event{data.total !== 1 ? "s" : ""} found
        </p>
      )}

      {/* Audit log — the design is a plain row list: no table, no column
          headers, no avatars, no Details column. Each row is
          timestamp / user / action pill / entity, and clicking it reveals the
          metadata this app records and the design has no equivalent for. */}
      <div className="overflow-hidden rounded-[14px] border border-border bg-card">
        {isLoading ? (
          <div className="space-y-2 p-5">
            {[1, 2, 3, 4, 5].map((i: number) => (
              <Skeleton key={i} className="h-10 w-full rounded-[8px]" />
            ))}
          </div>
        ) : !data?.logs.length ? (
          <div className="flex flex-col items-center py-16">
            <FileText className="h-8 w-8 text-tile" />
            <p className="mt-2.5 text-[12.5px] text-muted-foreground">
              No audit log entries found
            </p>
            {hasActiveFilters && (
              <Button
                variant="link"
                size="sm"
                className="mt-1 text-[12px] text-gold"
                onClick={resetFilters}
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          data.logs.map((log: any) => {
            const c = getActionColor(log.action);
            const isOpen = expandedRow === log.id;
            return (
              <Fragment key={log.id}>
                {/* A real grid, not a flex row. The action pill's width varies
                    with the label ("post / created" 88px vs
                    "billing / subscription cancelled" 172px), so an auto-width
                    pill pushed the entity column to a different x on every
                    row. The action column is fixed at 176px — the widest label
                    in ALL_ACTIONS, measured — so nothing truncates and all
                    four columns line up. The chevron slot is always reserved
                    so rows that carry no metadata still end flush. */}
                <div
                  role="button"
                  tabIndex={0}
                  className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-3.5 gap-y-1.5 border-b border-border px-5 py-[13px] transition-colors hover:bg-hover md:grid-cols-[130px_110px_176px_minmax(0,1fr)_14px] md:gap-y-0"
                  onClick={() => setExpandedRow(isOpen ? null : log.id)}
                  onKeyDown={(e: any) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setExpandedRow(isOpen ? null : log.id);
                    }
                  }}
                >
                  <span className="truncate text-[11px] leading-[1.3] text-faint">
                    {formatDate(log.createdAt)}
                  </span>
                  <span className="truncate text-[12px] font-medium leading-[1.3]">
                    {log.user?.name || log.user?.email || "System"}
                  </span>
                  {/* The cell is fixed-width; the pill inside hugs its label. */}
                  <span className="min-w-0">
                    <span
                      className={`inline-block max-w-full truncate whitespace-nowrap rounded-[5px] px-[9px] py-0.5 align-middle text-[10.5px] font-semibold leading-[1.6] ${
                        c ? "" : "bg-gold/[0.13] text-gold"
                      }`}
                      style={c ? { background: `${c}22`, color: c } : undefined}
                    >
                      {formatAction(log.action)}
                    </span>
                  </span>
                  <span className="min-w-0 truncate text-[11px] leading-[1.3] text-muted-foreground">
                    {log.entityType}{" "}
                    {log.entityId && (
                      // Fix #77: 8-char prefix, full ID on hover, click to copy
                      <button
                        className="group ml-0.5 inline-flex items-center gap-0.5 align-middle font-mono text-faint hover:text-foreground"
                        title={log.entityId}
                        onClick={(e: any) => {
                          e.stopPropagation();
                          copyEntityId(log.entityId);
                        }}
                      >
                        <code>{log.entityId.slice(0, 8)}…</code>
                        {copiedId === log.entityId ? (
                          <Check className="h-2.5 w-2.5 text-[#5cb85c]" />
                        ) : (
                          <Copy className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100" />
                        )}
                      </button>
                    )}
                  </span>
                  {/* Slot is always present so the right edge never jitters;
                      only rows with metadata paint a chevron into it. */}
                  <span className="flex w-3.5 justify-end">
                    {log.metadata ? (
                      isOpen ? (
                        <ChevronUp className="h-3.5 w-3.5 text-faint" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-faint" />
                      )
                    ) : null}
                  </span>
                </div>
                {isOpen && log.metadata && (
                  <div className="border-b border-border bg-surface1 px-5 py-3">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[8px] border border-border2 bg-background p-2.5 font-mono text-[11px] text-muted-foreground">
                      {JSON.stringify(log.metadata, null, 2)}
                    </pre>
                  </div>
                )}
              </Fragment>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] text-muted-foreground">
            Page {data.page} of {data.totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setPage((p: number) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className={OUTLINE_BTN}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                setPage((p: number) => Math.min(data.totalPages, p + 1))
              }
              disabled={page >= data.totalPages}
              className={OUTLINE_BTN}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function AuditLogPage() {
  return (
    <RequireAppAdmin>
      <AuditLogPageInner />
    </RequireAppAdmin>
  );
}
