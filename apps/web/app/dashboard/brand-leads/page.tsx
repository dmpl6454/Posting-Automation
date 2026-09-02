"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { useToast } from "~/hooks/use-toast";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { ScrollableTabRow } from "~/components/ui/scrollable-tab-row";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Star,
  ExternalLink,
  CheckCircle,
  XCircle,
  Mail,
  Linkedin,
  Twitter,
  Instagram,
  Zap,
  Target,
  Send,
  Clock,
  Copy,
  Flame,
  Newspaper,
  Briefcase,
  TrendingUp,
  Eye,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Info,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Lead = {
  id: string;
  status: string;
  digestDate: Date | string;
  createdAt: Date | string;
  signal: {
    id: string;
    brandName: string;
    celebrityNames: string[];
    signalType: string;
    signalUrl: string | null;
    score: number;
    brandEmail: string | null;
    brandTwitter: string | null;
    brandInstagram: string | null;
    brandLinkedin: string | null;
    detectedAt: Date | string;
  };
  messages: {
    id: string;
    channel: string;
    subject: string | null;
    body: string;
    status: string;
    sentAt: Date | string | null;
  }[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Design: lead status is a tinted pill. Literal hex — this project's Tailwind
 * config FLATTENS the yellow/green/red scales onto the palette's status
 * triplets, so `bg-yellow-100 text-yellow-800` renders the label the same
 * colour as its own background.
 *
 * The mockup covers PENDING/APPROVED/REJECTED/SENT; the four manual outcomes
 * this app also stores take neighbouring palette hues so none falls through
 * to an untinted grey.
 */
const STATUS_STYLES: Record<string, string> = {
  PENDING:        "bg-[rgba(224,184,74,0.15)] text-[#e0b84a]",
  APPROVED:       "bg-[rgba(91,155,213,0.15)] text-[#5b9bd5]",
  REJECTED:       "bg-tile text-muted-foreground",
  SENT:           "bg-[rgba(92,184,92,0.15)] text-[#5cb85c]",
  FAILED:         "bg-[rgba(217,105,95,0.15)] text-[#d9695f]",
  // Manual post-send outcomes (gap #3)
  REPLIED:        "bg-gold/[0.12] text-gold",
  INTERESTED:     "bg-[rgba(92,184,92,0.15)] text-[#5cb85c]",
  NOT_INTERESTED: "bg-tile text-muted-foreground",
  CLOSED:         "bg-tile text-faint",
};

/** The design's one 9.5px/600 status pill. */
const STATUS_PILL =
  "shrink-0 rounded-full px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6]";

// Human label for the manual outcome statuses (raw enum would show NOT_INTERESTED).
const LEAD_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected", SENT: "Sent", FAILED: "Failed",
  REPLIED: "Replied", INTERESTED: "Interested", NOT_INTERESTED: "Not interested", CLOSED: "Closed",
};

// The manual outcomes an operator can set on a lead after sending (gap #3).
const MANUAL_OUTCOMES = ["REPLIED", "INTERESTED", "NOT_INTERESTED", "CLOSED"] as const;

/**
 * Design: the signal chip is a tinted 9.5px tag, one hue per detector source.
 * `Icon` is stored (not an element) so the same entry renders at the chip's 9px
 * and the breakdown row's 11px without a second table.
 */
const SIGNAL_META: Record<string, { label: string; Icon: typeof Mail; color: string }> = {
  AD_LIBRARY:   { label: "Meta Ads",    Icon: TrendingUp, color: "#5b9bd5" },
  PR_NEWS:      { label: "PR / News",   Icon: Newspaper,  color: "#C9A356" },
  SOCIAL_MEDIA: { label: "Social",      Icon: Flame,      color: "#e08a4a" },
  JOB_POSTING:  { label: "Job Posting", Icon: Briefcase,  color: "#8a8578" },
};

const CHANNEL_META: Record<string, { Icon: typeof Mail; label: string }> = {
  EMAIL:     { Icon: Mail,      label: "Email" },
  LINKEDIN:  { Icon: Linkedin,  label: "LinkedIn" },
  TWITTER:   { Icon: Twitter,   label: "Twitter" },
  INSTAGRAM: { Icon: Instagram, label: "Instagram" },
};

const MSG_STATUS_STYLES: Record<string, string> = {
  DRAFT:          "text-muted-foreground",
  QUEUED:         "text-[#5b9bd5]",
  SENT:           "text-[#5cb85c]",
  FAILED:         "text-[#d9695f]",
  PENDING_MANUAL: "text-[#e0b84a]",
};

// Friendly label for each message status (PENDING_MANUAL would otherwise read as
// the raw enum). Channels with no send API land here for a manual copy-paste send.
const MSG_STATUS_LABEL: Record<string, string> = {
  DRAFT:          "Draft",
  QUEUED:         "Queued",
  SENT:           "Sent",
  FAILED:         "Failed",
  PENDING_MANUAL: "Send manually",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Design: three 11px flames, gold when lit and `--tile` when not.
 *
 * ⚠️ STROKE ONLY — measured on the mockup, its flames compute to `fill: none`.
 * Filling them (the app's previous `fill-gold`) turns each one into a solid
 * gold blob, which reads as a heavier, different mark at 11px.
 */
function ScoreFlames({ score, size = "h-[11px] w-[11px]" }: { score: number; size?: string }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3].map((i) => (
        <Flame
          key={i}
          className={`${size} fill-none ${i <= score ? "text-gold" : "text-tile"}`}
        />
      ))}
    </div>
  );
}

function ChannelDots({ lead }: { lead: Lead }) {
  const available = [
    lead.signal.brandEmail    && "EMAIL",
    lead.signal.brandLinkedin && "LINKEDIN",
    lead.signal.brandTwitter  && "TWITTER",
    lead.signal.brandInstagram && "INSTAGRAM",
  ].filter(Boolean) as string[];

  if (available.length === 0) {
    return <span className="text-[11px] leading-none text-faint">No contacts</span>;
  }

  return (
    <div className="flex gap-1.5">
      {available.map((ch) => {
        const meta = CHANNEL_META[ch];
        if (!meta) return null;
        const sent = lead.messages.find((m) => m.channel === ch);
        /* Design: a 24px bordered square per reachable channel. The send state
           is carried by the glyph's colour, so a sent channel is legible
           without a second row of labels. */
        const tone =
          sent?.status === "SENT"           ? "border-[rgba(92,184,92,0.35)] text-[#5cb85c]" :
          sent?.status === "FAILED"         ? "border-[rgba(217,105,95,0.35)] text-[#d9695f]" :
          sent?.status === "QUEUED"         ? "border-[rgba(91,155,213,0.35)] text-[#5b9bd5]" :
          sent?.status === "PENDING_MANUAL" ? "border-[rgba(224,184,74,0.35)] text-[#e0b84a]" :
          "border-border2 text-muted-foreground";
        return (
          <span
            key={ch}
            title={`${meta.label}: ${sent ? (MSG_STATUS_LABEL[sent.status] ?? sent.status) : "not sent"}`}
            className={`flex h-6 w-6 items-center justify-center rounded-[6px] border ${tone}`}
          >
            <meta.Icon className="h-[11px] w-[11px]" />
          </span>
        );
      })}
    </div>
  );
}

function LeadCard({ lead, onApprove, onReject, onView, isApproving, isRejecting }: {
  lead: Lead;
  onApprove: () => void;
  onReject: () => void;
  onView: () => void;
  isApproving: boolean;
  isRejecting: boolean;
}) {
  const signal = SIGNAL_META[lead.signal.signalType] ?? SIGNAL_META.PR_NEWS!;

  return (
    <div className="rounded-[12px] border border-border bg-card px-4 py-3 shadow-[0_6px_14px_-10px_rgba(0,0,0,.4)] transition-colors hover:border-border2">
      <div className="flex items-center gap-3.5">
        {/* Score — design: the flame stack sits in its own left column with the
            numeric score beneath it, so the list can be scanned by heat. */}
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <ScoreFlames score={lead.signal.score} />
          <span className="whitespace-nowrap text-[8.5px] font-medium leading-none text-faint">
            Score {lead.signal.score}
          </span>
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-[13px] font-semibold leading-[1.3]">{lead.signal.brandName}</span>
              <span
                className="flex shrink-0 items-center gap-1 rounded-[5px] px-2 py-0.5 text-[9.5px] font-medium leading-[1.6]"
                style={{ background: `${signal.color}1f`, color: signal.color }}
              >
                <signal.Icon className="h-[9px] w-[9px]" />
                {signal.label}
              </span>
              <span className={`${STATUS_PILL} ${STATUS_STYLES[lead.status] ?? "bg-tile text-muted-foreground"}`}>
                {LEAD_STATUS_LABEL[lead.status] ?? lead.status}
              </span>
              {lead.signal.celebrityNames.map((name) => (
                <span
                  key={name}
                  className="shrink-0 rounded-[5px] bg-tile px-2 py-0.5 text-[10.5px] font-medium leading-[1.6] text-muted-foreground"
                >
                  ⭐ {name}
                </span>
              ))}
            </div>

            <span className="ml-auto shrink-0 text-[11px] leading-none text-faint">
              {new Date(lead.signal.detectedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
            </span>
          </div>

          {/* Design: one action row, channels pushed left and the actions right.
              These are NOT hover-revealed — Approve/Reject are the whole point
              of the page, and a control that only exists on hover is invisible
              on a touch screen. */}
          <div className="mt-[9px] flex flex-wrap items-center justify-end gap-1.5">
            <div className="mr-auto">
              <ChannelDots lead={lead} />
            </div>

            <Button
              size="sm"
              variant="ghost"
              className="h-[25px] gap-1.5 rounded-[6px] px-2.5 text-[11px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
              onClick={onView}
            >
              <Eye className="h-[11px] w-[11px]" /> Preview
            </Button>

            {lead.signal.signalUrl && (
              <a href={lead.signal.signalUrl} target="_blank" rel="noopener noreferrer">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-[25px] gap-1.5 rounded-[6px] px-2.5 text-[11px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
                >
                  <ExternalLink className="h-[11px] w-[11px]" /> Source
                </Button>
              </a>
            )}

            {lead.status === "PENDING" && (
              <>
                <Button
                  size="sm"
                  className="h-[25px] gap-1.5 rounded-[6px] bg-[#5cb85c] px-2.5 text-[11px] font-semibold text-[#0e0e0c] hover:bg-[#5cb85c] hover:brightness-110"
                  onClick={onApprove}
                  disabled={isApproving}
                >
                  {isApproving ? <Loader2 className="h-[11px] w-[11px] animate-spin" /> : <CheckCircle className="h-[11px] w-[11px]" />}
                  Approve
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-[25px] w-[25px] rounded-[6px] text-faint hover:bg-hover hover:text-[#c96b56]"
                  aria-label="Reject lead"
                  onClick={onReject}
                  disabled={isRejecting}
                >
                  {isRejecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessagePreviewDialog({ lead, open, onClose, onStatusChange }: {
  lead: Lead | null;
  open: boolean;
  onClose: () => void;
  onStatusChange?: (status: string) => void;
}) {
  const utils = trpc.useUtils();
  const { data: messages, isLoading } = trpc.brandLeads.messages.useQuery(
    { leadId: lead?.id ?? "" },
    { enabled: open && !!lead }
  );

  // BO-03/BO-04 lockout fix: gate manual-outcome logging on whether a message
  // EVER reached SENT (an append-only historical fact, mirrors the server's
  // outreachMessage.count check), NOT on the lead's CURRENT `status`. BO-03
  // patches `lead.status` to the just-logged outcome (e.g. "REPLIED") on every
  // successful setStatus call — gating on `lead.status !== "SENT"` after that
  // would read true forever and permanently disable the buttons after the
  // very first outcome was logged. `messages` is already loaded above, so this
  // stays correct (and keeps being true) once at least one message was sent.
  const hasEverSent = messages?.some((m) => m.status === "SENT") ?? false;

  // Gap #3: log a manual reply/outcome on the lead (no inbox automation exists —
  // the operator records what happened after they sent the outreach by hand).
  const setStatus = trpc.brandLeads.setStatus.useMutation({
    onSuccess: (_data, variables) => {
      utils.brandLeads.list.invalidate();
      utils.brandLeads.stats.invalidate();
      // BO-03: the `lead` prop is a frozen snapshot captured when the dialog
      // was opened — invalidating the list query doesn't touch it. Patch the
      // parent's copy directly with the status we just set (from `variables`,
      // not a closed-over value) so the chip updates without a reopen.
      onStatusChange?.(variables.status);
    },
  });

  if (!lead) return null;

  const channels = [
    lead.signal.brandEmail    && "EMAIL",
    lead.signal.brandLinkedin && "LINKEDIN",
    lead.signal.brandTwitter  && "TWITTER",
    lead.signal.brandInstagram && "INSTAGRAM",
  ].filter(Boolean) as string[];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="h-4 w-4 text-gold" />
            {lead.signal.brandName}
            {lead.signal.celebrityNames.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                × {lead.signal.celebrityNames.join(", ")}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Signal info */}
        <div className="space-y-1.5 rounded-[10px] border border-border bg-surface1 p-3 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-muted-foreground">
            {(() => {
              const meta = SIGNAL_META[lead.signal.signalType];
              return meta ? (
                <span className="flex items-center gap-1.5" style={{ color: meta.color }}>
                  <meta.Icon className="h-3 w-3" />
                  {meta.label}
                </span>
              ) : null;
            })()}
            <span className="flex items-center gap-1.5">
              <ScoreFlames score={lead.signal.score} />
              Score {lead.signal.score}/3
            </span>
            <span>{new Date(lead.signal.detectedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</span>
          </div>
          {lead.signal.signalUrl && (
            <a href={lead.signal.signalUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11.5px] text-gold hover:underline">
              <ExternalLink className="h-3 w-3" /> View original source
            </a>
          )}
          {channels.length === 0 && (
            <p className="flex items-center gap-1 text-[11.5px] text-[#e0b84a]">
              <AlertCircle className="h-3 w-3" />
              No contact info found for this brand yet
            </p>
          )}
        </div>

        {/* Manual reply / outcome tracking (gap #3). No inbox automation exists —
            the operator logs what happened after they reached out. */}
        <div className="space-y-2 rounded-[10px] border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-muted-foreground">Log a reply / outcome</span>
            <span className={`${STATUS_PILL} ${STATUS_STYLES[lead.status] ?? "bg-tile text-muted-foreground"}`}>
              {LEAD_STATUS_LABEL[lead.status] ?? lead.status}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {MANUAL_OUTCOMES.map((outcome) => (
              <Button
                key={outcome}
                size="sm"
                variant={lead.status === outcome ? "default" : "outline"}
                disabled={setStatus.isPending || !hasEverSent}
                className="h-7 text-[11px]"
                onClick={() => setStatus.mutate({ leadId: lead.id, status: outcome })}
              >
                {LEAD_STATUS_LABEL[outcome]}
              </Button>
            ))}
          </div>
          {/* BO-04: these are post-send outcomes — gate them until outreach has
              actually gone out, so we don't log e.g. "Replied" on a PENDING lead.
              Gated on hasEverSent (not lead.status), so it never re-locks once a
              real send has happened, no matter how many times the outcome changes. */}
          {!hasEverSent && (
            <p className="text-[10px] text-[#e0b84a]">
              Available after outreach is sent.
            </p>
          )}
          <p className="text-[10px] text-muted-foreground">
            Replies aren&apos;t tracked automatically — set the outcome here after you hear back.
          </p>
        </div>

        {/* Outreach messages */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Outreach Messages</h3>

          {isLoading && (
            <div className="space-y-2">
              {[1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
            </div>
          )}

          {!isLoading && messages && messages.length === 0 && (
            <div className="rounded-[10px] border border-dashed border-border2 p-6 text-center text-[12.5px] text-muted-foreground">
              {lead.status === "APPROVED"
                ? "Messages are being generated — check back shortly."
                : lead.status === "PENDING"
                ? "Approve this lead to generate personalized outreach messages."
                : "No messages were generated for this lead."}
            </div>
          )}

          {messages?.map((msg) => (
            /* Design: a surface-1 card with a `--tile` header strip carrying the
               channel glyph and subject, and the body at 12px/1.6. */
            <div key={msg.id} className="overflow-hidden rounded-[10px] border border-border bg-surface1">
              <div className="flex items-center justify-between gap-2 border-b border-border bg-tile px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-[7px]">
                  {(() => {
                    const cm = CHANNEL_META[msg.channel];
                    return cm ? <cm.Icon className="h-3 w-3 shrink-0 text-muted-foreground" /> : null;
                  })()}
                  <span className="text-[11.5px] font-medium">{CHANNEL_META[msg.channel]?.label}</span>
                  {msg.subject && <span className="truncate text-[11px] text-muted-foreground">— {msg.subject}</span>}
                </div>
                <span className={`flex shrink-0 items-center gap-1 text-[10px] font-medium ${MSG_STATUS_STYLES[msg.status]}`}>
                  {msg.status === "SENT" && <CheckCircle2 className="h-3 w-3" />}
                  {msg.status === "FAILED" && <AlertCircle className="h-3 w-3" />}
                  {msg.status === "QUEUED" && <Loader2 className="h-3 w-3 animate-spin" />}
                  {msg.status === "PENDING_MANUAL" && <Clock className="h-3 w-3" />}
                  {MSG_STATUS_LABEL[msg.status] ?? msg.status}
                  {msg.sentAt && ` · ${new Date(msg.sentAt).toLocaleTimeString("en-IN", { timeStyle: "short" })}`}
                </span>
              </div>
              {/* Channels with no send API (LinkedIn/Instagram DM) come back as
                  PENDING_MANUAL — the copy is ready but the operator must send it
                  by hand. Make that explicit and one-click-copyable. */}
              {msg.status === "PENDING_MANUAL" && (
                <div className="flex items-center justify-between gap-2 border-b border-[rgba(224,184,74,0.3)] bg-[rgba(224,184,74,0.12)] px-3 py-1.5">
                  <span className="text-[11px] text-[#e0b84a]">
                    No automatic send for {CHANNEL_META[msg.channel]?.label} — copy and send it manually.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 rounded-[6px] border-border2 bg-surface2 px-2 text-[11px]"
                    onClick={() => {
                      navigator.clipboard.writeText(msg.subject ? `${msg.subject}\n\n${msg.body}` : msg.body);
                    }}
                  >
                    <Copy className="h-3 w-3 mr-1" /> Copy
                  </Button>
                </div>
              )}
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap p-3 font-sans text-[12px] leading-[1.6] text-muted-foreground">
                {msg.body}
              </pre>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function BrandLeadsPageInner() {
  const [activeTab, setActiveTab] = useState<"pending" | "all" | "sent">("pending");
  const [signalFilter, setSignalFilter] = useState<string>("all");
  const [previewLead, setPreviewLead] = useState<Lead | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const utils = trpc.useUtils();
  const { toast } = useToast();

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await Promise.all([
        utils.brandLeads.list.invalidate(),
        utils.brandLeads.stats.invalidate(),
      ]);
      toast({ title: "Leads refreshed", description: "Showing the latest saved leads." });
    } finally {
      setIsRefreshing(false);
    }
  };

  const { data: stats, isLoading: statsLoading } = trpc.brandLeads.stats.useQuery();

  const statusMap: Record<string, string | undefined> = {
    pending: "PENDING",
    all: undefined,
    sent: "SENT",
  };

  const { data: leads, isLoading: leadsLoading } = trpc.brandLeads.list.useQuery({
    status: statusMap[activeTab] as any,
    signalType: signalFilter !== "all" ? signalFilter as any : undefined,
    days: 30,
  });

  /*
   * "Approve All Today" is a HEADER action, so its count must not depend on
   * which tab is open. It used to be derived from `leads` — the current tab's
   * result — so opening the Sent tab (which by definition contains no PENDING
   * lead) dropped the count to 0 and the button vanished; picking a signal
   * filter that excluded today's leads did the same. Measured: visible on
   * Pending Review and All Leads, GONE on Sent.
   *
   * Same existing procedure, just pinned to PENDING and unfiltered by signal.
   */
  const { data: pendingLeads } = trpc.brandLeads.list.useQuery({
    status: "PENDING",
    days: 30,
  });

  const approve = trpc.brandLeads.approve.useMutation({
    onMutate: ({ leadId }) => setApprovingId(leadId),
    onSettled: () => {
      setApprovingId(null);
      utils.brandLeads.list.invalidate();
      utils.brandLeads.stats.invalidate();
    },
  });

  const reject = trpc.brandLeads.reject.useMutation({
    onMutate: ({ leadId }) => setRejectingId(leadId),
    onSettled: () => {
      setRejectingId(null);
      utils.brandLeads.list.invalidate();
      utils.brandLeads.stats.invalidate();
    },
  });

  const approveAll = trpc.brandLeads.approveAll.useMutation({
    onSuccess: () => {
      utils.brandLeads.list.invalidate();
      utils.brandLeads.stats.invalidate();
    },
  });

  const tabs = [
    { key: "pending", label: "Pending Review", count: stats?.pending },
    { key: "all",     label: "All Leads",      count: stats?.total },
    { key: "sent",    label: "Sent",           count: stats?.sent },
  ] as const;

  const statCards = [
    { title: "Detected Today",  value: stats?.todayCount, icon: Target, color: "#5b9bd5", tint: "rgba(91,155,213,0.12)" },
    { title: "Pending Approval",value: stats?.pending,    icon: Clock,  color: "#e0b84a", tint: "rgba(224,184,74,0.12)" },
    { title: "Outreach Sent",   value: stats?.sent,       icon: Send,   color: "#5cb85c", tint: "rgba(92,184,92,0.12)" },
    { title: "Total Leads",     value: stats?.total,      icon: Star,   color: "hsl(var(--accent-gold))", tint: "hsl(var(--accent-gold) / 0.12)" },
  ];

  const filteredLeads = leads ?? [];
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  // Tab-independent (see the `pendingLeads` query above).
  const pendingTodayCount = (pendingLeads ?? []).filter(
    (l) => new Date(l.createdAt) >= startOfToday
  ).length;

  return (
    /* Design stacks sections on 20px, not 24px. */
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <span className="eyebrow">Brand Outreach</span>
          <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
            Find the fit, make the ask.
          </h1>
          <p className="mt-2 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
            Leads are found automatically — your job here is to <strong className="font-semibold text-foreground">review and approve</strong> the brands worth contacting.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-[34px] gap-[7px] rounded-[9px] border-border2 bg-surface2 px-[13px] text-[12px] font-medium hover:bg-hover"
            title="Re-reads saved leads — detection runs automatically in the background"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={`h-[13px] w-[13px] ${isRefreshing ? "animate-spin" : ""}`} />
            {isRefreshing ? "Refreshing…" : "Reload"}
          </Button>
          {pendingTodayCount > 0 && (
            /* Design keeps this one green, not gold: it is a bulk APPROVE, and
               the page's approve action is green everywhere else on the page. */
            <Button
              size="sm"
              className="h-[34px] gap-[7px] rounded-[9px] bg-[#5cb85c] px-3.5 text-[12px] font-semibold text-[#0e0e0c] hover:bg-[#5cb85c] hover:brightness-110"
              onClick={() => approveAll.mutate()}
              disabled={approveAll.isPending}
            >
              {approveAll.isPending
                ? <Loader2 className="h-[13px] w-[13px] animate-spin" />
                : <CheckCircle className="h-[13px] w-[13px]" />}
              Approve All Today ({pendingTodayCount})
            </Button>
          )}
        </div>
      </div>

      {/* Design: a quiet surface-1 note, not the Alert component's framing. */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
        <Info className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
        <p className="text-[12px] leading-[1.7] text-muted-foreground">
          <b className="text-foreground">How Brand Outreach works:</b> a detector scans Meta Ad Library,
          PR/news, and social signals every 6 hours for brands launching celebrity campaigns, then
          enriches each with contact info and lists it here. <b className="text-foreground">Approve</b> a
          lead and we generate a personalised pitch: email sends automatically, LinkedIn/Instagram DMs are
          marked “Send manually” with the copy ready to paste. Log replies on the lead after you hear back.
          <span className="mt-1 block text-[11px] leading-[1.6] text-faint">
            Brand Outreach is standalone — it finds its own leads and isn’t fed by your Listening,
            Campaigns, or Approvals data. Detection coverage depends on configured API keys (Meta Ad
            Library, Twitter, Hunter); with none set, no new leads are found.
          </span>
        </p>
      </div>

      {/* Stats — design: 3px accent rail + tinted 28px icon tile, 26px value. */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((s) => (
          <div
            key={s.title}
            className="relative overflow-hidden rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)]"
          >
            <span className="absolute left-0 top-0 h-full w-[3px]" style={{ background: s.color }} />
            <div className="flex items-center justify-between gap-2.5">
              <span className="whitespace-nowrap text-[11px] font-medium leading-[1.3] text-muted-foreground">
                {s.title}
              </span>
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]"
                style={{ background: s.tint }}
              >
                <s.icon className="h-[13px] w-[13px] shrink-0" style={{ color: s.color }} />
              </div>
            </div>
            {statsLoading ? (
              <Skeleton className="mt-2.5 h-[26px] w-16" />
            ) : (
              <div className="mt-2.5 text-[26px] font-bold leading-none tracking-[-0.01em]">
                {s.value ?? 0}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Tabs + Filter — design: underline tabs sharing one bottom rule with the
          signal filter, which sits on the same baseline at the right. */}
      <div className="flex flex-wrap items-center justify-between gap-3.5 border-b border-border pb-3">
        <ScrollableTabRow role="tablist" className="-mb-[13px] min-w-0 gap-[18px]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-1 py-[9px] text-[12.5px] font-medium leading-none transition-colors ${
                activeTab === tab.key
                  ? "border-gold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className="ml-1.5 text-faint">({tab.count})</span>
              )}
            </button>
          ))}
        </ScrollableTabRow>

        <Select value={signalFilter} onValueChange={setSignalFilter}>
          <SelectTrigger className="h-8 w-full rounded-[8px] border-border2 bg-surface2 px-3 text-[12px] font-medium sm:w-40">
            <SelectValue placeholder="Signal type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All signals</SelectItem>
            <SelectItem value="AD_LIBRARY">Meta Ads</SelectItem>
            <SelectItem value="PR_NEWS">PR / News</SelectItem>
            <SelectItem value="SOCIAL_MEDIA">Social Media</SelectItem>
            <SelectItem value="JOB_POSTING">Job Posting</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Leads list */}
      <div className="space-y-2">
        {leadsLoading && (
          <>
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-[88px] rounded-xl" />
            ))}
          </>
        )}

        {!leadsLoading && filteredLeads.length === 0 && (
          <div className="flex flex-col items-center rounded-[12px] border border-border bg-card px-4 py-12 text-center">
            <Zap className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <h3 className="text-[13px] font-semibold">
              {activeTab === "pending" ? "No pending leads" : "No leads found"}
            </h3>
            <p className="mt-1 max-w-xs text-[11.5px] leading-[1.5] text-muted-foreground">
              {activeTab === "pending"
                ? "All caught up! New leads are detected every 6 hours from news, ads, and social signals."
                : "No brand leads in the last 30 days. The detector runs every 6 hours."}
            </p>
          </div>
        )}

        {filteredLeads.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead as Lead}
            onApprove={() => approve.mutate({ leadId: lead.id })}
            onReject={() => reject.mutate({ leadId: lead.id })}
            onView={() => setPreviewLead(lead as Lead)}
            isApproving={approvingId === lead.id}
            isRejecting={rejectingId === lead.id}
          />
        ))}
      </div>

      {/* Signal source breakdown */}
      {!leadsLoading && filteredLeads.length > 0 && (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-border pt-3">
          <span className="text-[11px] leading-none text-muted-foreground">Signal breakdown:</span>
          {(["AD_LIBRARY", "PR_NEWS", "SOCIAL_MEDIA", "JOB_POSTING"] as const).map((type) => {
            const count = filteredLeads.filter((l) => l.signal.signalType === type).length;
            if (count === 0) return null;
            const meta = SIGNAL_META[type]!;
            return (
              <span
                key={type}
                className="inline-flex items-center gap-[5px] rounded-[6px] px-[9px] py-0.5 text-[10.5px] font-medium leading-[1.6]"
                style={{ background: `${meta.color}1f`, color: meta.color }}
              >
                <meta.Icon className="h-[11px] w-[11px]" />
                {meta.label} · {count}
              </span>
            );
          })}
        </div>
      )}

      {/* Message preview dialog */}
      <MessagePreviewDialog
        lead={previewLead}
        open={!!previewLead}
        onClose={() => setPreviewLead(null)}
        onStatusChange={(status) => setPreviewLead((prev) => prev ? { ...prev, status } : prev)}
      />
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function BrandLeadsPage() {
  return (
    <RequireAppAdmin>
      <BrandLeadsPageInner />
    </RequireAppAdmin>
  );
}
