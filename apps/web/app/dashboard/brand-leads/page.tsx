"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
  Search,
  Flame,
  Newspaper,
  Briefcase,
  TrendingUp,
  Eye,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
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

const STATUS_STYLES: Record<string, string> = {
  PENDING:  "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  APPROVED: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  REJECTED: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  SENT:     "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  FAILED:   "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
};

const SIGNAL_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  AD_LIBRARY:   { label: "Meta Ads",    icon: <TrendingUp className="h-3 w-3" />,  color: "bg-blue-50 text-blue-700 border-blue-200" },
  PR_NEWS:      { label: "PR / News",   icon: <Newspaper className="h-3 w-3" />,   color: "bg-purple-50 text-purple-700 border-purple-200" },
  SOCIAL_MEDIA: { label: "Social",      icon: <Flame className="h-3 w-3" />,        color: "bg-orange-50 text-orange-700 border-orange-200" },
  JOB_POSTING:  { label: "Job Posting", icon: <Briefcase className="h-3 w-3" />,   color: "bg-gray-50 text-gray-600 border-gray-200" },
};

const CHANNEL_META: Record<string, { icon: React.ReactNode; label: string }> = {
  EMAIL:     { icon: <Mail className="h-3.5 w-3.5" />,     label: "Email" },
  LINKEDIN:  { icon: <Linkedin className="h-3.5 w-3.5" />, label: "LinkedIn" },
  TWITTER:   { icon: <Twitter className="h-3.5 w-3.5" />,  label: "Twitter" },
  INSTAGRAM: { icon: <Instagram className="h-3.5 w-3.5" />,label: "Instagram" },
};

const MSG_STATUS_STYLES: Record<string, string> = {
  DRAFT:  "text-muted-foreground",
  QUEUED: "text-blue-500",
  SENT:   "text-emerald-600",
  FAILED: "text-red-500",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreFlames({ score }: { score: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3].map((i) => (
        <Flame
          key={i}
          className={`h-3.5 w-3.5 ${i <= score ? "text-orange-500 fill-orange-500" : "text-gray-200 fill-gray-200 dark:text-gray-700 dark:fill-gray-700"}`}
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
    return <span className="text-xs text-muted-foreground">No contacts</span>;
  }

  return (
    <div className="flex gap-1.5">
      {available.map((ch) => {
        const sent = lead.messages.find((m) => m.channel === ch);
        return (
          <span
            key={ch}
            title={`${CHANNEL_META[ch]?.label}: ${sent ? sent.status : "not sent"}`}
            className={`p-1 rounded-md border ${
              sent?.status === "SENT"   ? "border-emerald-200 bg-emerald-50 text-emerald-600" :
              sent?.status === "FAILED" ? "border-red-200 bg-red-50 text-red-500" :
              sent?.status === "QUEUED" ? "border-blue-200 bg-blue-50 text-blue-500" :
              "border-border/50 text-muted-foreground"
            }`}
          >
            {CHANNEL_META[ch]?.icon}
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
    <div className="group flex items-start gap-4 rounded-xl border border-border/50 bg-card p-4 transition-all hover:border-border hover:shadow-sm">
      {/* Score */}
      <div className="flex flex-col items-center gap-1.5 pt-0.5">
        <ScoreFlames score={lead.signal.score} />
        <span className="text-[10px] text-muted-foreground font-medium">Score {lead.signal.score}</span>
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm truncate">{lead.signal.brandName}</span>
              <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${signal.color}`}>
                {signal.icon}
                {signal.label}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[lead.status]}`}>
                {lead.status}
              </span>
            </div>

            {lead.signal.celebrityNames.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {lead.signal.celebrityNames.map((name) => (
                  <span key={name} className="rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium">
                    ⭐ {name}
                  </span>
                ))}
              </div>
            )}
          </div>

          <span className="text-[11px] text-muted-foreground shrink-0">
            {new Date(lead.signal.detectedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
          </span>
        </div>

        <div className="flex items-center justify-between mt-2.5 gap-2 flex-wrap">
          <ChannelDots lead={lead} />

          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={onView}>
              <Eye className="h-3 w-3" /> Preview
            </Button>

            {lead.signal.signalUrl && (
              <a href={lead.signal.signalUrl} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1">
                  <ExternalLink className="h-3 w-3" /> Source
                </Button>
              </a>
            )}

            {lead.status === "PENDING" && (
              <>
                <Button
                  size="sm"
                  className="h-7 px-2.5 text-xs bg-emerald-600 hover:bg-emerald-700 gap-1"
                  onClick={onApprove}
                  disabled={isApproving}
                >
                  {isApproving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={onReject}
                  disabled={isRejecting}
                >
                  <XCircle className="h-3 w-3" />
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessagePreviewDialog({ lead, open, onClose }: {
  lead: Lead | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data: messages, isLoading } = trpc.brandLeads.messages.useQuery(
    { leadId: lead?.id ?? "" },
    { enabled: open && !!lead }
  );

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
            <Star className="h-4 w-4 text-orange-500" />
            {lead.signal.brandName}
            {lead.signal.celebrityNames.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                × {lead.signal.celebrityNames.join(", ")}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Signal info */}
        <div className="rounded-lg border border-border/50 bg-muted/30 p-3 text-sm space-y-1.5">
          <div className="flex items-center gap-6 flex-wrap text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {SIGNAL_META[lead.signal.signalType]?.icon}
              {SIGNAL_META[lead.signal.signalType]?.label}
            </span>
            <span className="flex items-center gap-1.5">
              <ScoreFlames score={lead.signal.score} />
              Score {lead.signal.score}/3
            </span>
            <span>{new Date(lead.signal.detectedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</span>
          </div>
          {lead.signal.signalUrl && (
            <a href={lead.signal.signalUrl} target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline flex items-center gap-1">
              <ExternalLink className="h-3 w-3" /> View original source
            </a>
          )}
          {channels.length === 0 && (
            <p className="text-xs text-amber-600 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              No contact info found for this brand yet
            </p>
          )}
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
            <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
              {lead.status === "APPROVED"
                ? "Messages are being generated — check back shortly."
                : lead.status === "PENDING"
                ? "Approve this lead to generate personalized outreach messages."
                : "No messages were generated for this lead."}
            </div>
          )}

          {messages?.map((msg) => (
            <div key={msg.id} className="rounded-lg border border-border/50 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b border-border/50">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{CHANNEL_META[msg.channel]?.icon}</span>
                  <span className="text-xs font-medium">{CHANNEL_META[msg.channel]?.label}</span>
                  {msg.subject && <span className="text-xs text-muted-foreground">— {msg.subject}</span>}
                </div>
                <span className={`flex items-center gap-1 text-[10px] font-medium ${MSG_STATUS_STYLES[msg.status]}`}>
                  {msg.status === "SENT" && <CheckCircle2 className="h-3 w-3" />}
                  {msg.status === "FAILED" && <AlertCircle className="h-3 w-3" />}
                  {msg.status === "QUEUED" && <Loader2 className="h-3 w-3 animate-spin" />}
                  {msg.status}
                  {msg.sentAt && ` · ${new Date(msg.sentAt).toLocaleTimeString("en-IN", { timeStyle: "short" })}`}
                </span>
              </div>
              <pre className="p-3 text-xs whitespace-pre-wrap text-foreground/80 font-sans leading-relaxed max-h-48 overflow-y-auto">
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

export default function BrandLeadsPage() {
  const [activeTab, setActiveTab] = useState<"pending" | "all" | "sent">("pending");
  const [signalFilter, setSignalFilter] = useState<string>("all");
  const [previewLead, setPreviewLead] = useState<Lead | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const utils = trpc.useUtils();

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
    { title: "Detected Today",  value: stats?.todayCount, icon: Target,      color: "text-blue-500" },
    { title: "Pending Approval",value: stats?.pending,    icon: Clock,       color: "text-yellow-500" },
    { title: "Outreach Sent",   value: stats?.sent,       icon: Send,        color: "text-emerald-500" },
    { title: "Total Leads",     value: stats?.total,      icon: Star,        color: "text-purple-500" },
  ];

  const filteredLeads = leads ?? [];
  const pendingCount = filteredLeads.filter((l) => l.status === "PENDING").length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Brand Outreach</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Celebrity brand campaigns detected automatically — approve to queue personalized outreach
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => { utils.brandLeads.list.invalidate(); utils.brandLeads.stats.invalidate(); }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          {pendingCount > 0 && (
            <Button
              size="sm"
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => approveAll.mutate()}
              disabled={approveAll.isPending}
            >
              {approveAll.isPending
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <CheckCircle className="h-3.5 w-3.5" />}
              Approve All Today ({pendingCount})
            </Button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((s) => (
          <Card key={s.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.title}</CardTitle>
              <s.icon className={`h-4 w-4 ${s.color}`} />
            </CardHeader>
            <CardContent>
              {statsLoading
                ? <Skeleton className="h-8 w-16" />
                : <p className="text-2xl font-bold">{s.value ?? 0}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs + Filter */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex border-b border-border/50">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className="ml-1.5 text-xs text-muted-foreground">({tab.count})</span>
              )}
            </button>
          ))}
        </div>

        <Select value={signalFilter} onValueChange={setSignalFilter}>
          <SelectTrigger className="w-40 h-8 text-xs">
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
          <Card>
            <CardContent className="flex flex-col items-center py-12 text-center">
              <Zap className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <h3 className="text-sm font-semibold">
                {activeTab === "pending" ? "No pending leads" : "No leads found"}
              </h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                {activeTab === "pending"
                  ? "All caught up! New leads are detected every 6 hours from news, ads, and social signals."
                  : "No brand leads in the last 30 days. The detector runs every 6 hours."}
              </p>
            </CardContent>
          </Card>
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
        <div className="flex items-center gap-3 pt-2 border-t border-border/50">
          <span className="text-xs text-muted-foreground">Signal breakdown:</span>
          {(["AD_LIBRARY", "PR_NEWS", "SOCIAL_MEDIA", "JOB_POSTING"] as const).map((type) => {
            const count = filteredLeads.filter((l) => l.signal.signalType === type).length;
            if (count === 0) return null;
            const meta = SIGNAL_META[type]!;
            return (
              <span key={type} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${meta.color}`}>
                {meta.icon}
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
      />
    </div>
  );
}
