"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Skeleton } from "~/components/ui/skeleton";
import { ScrollableTabRow } from "~/components/ui/scrollable-tab-row";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Target,
  Plus,
  Users,
  Hash,
  ExternalLink,
  Calendar,
  Loader2,
  Trash2,
  Pause,
  Play,
  Search,
  Globe,
  Twitter,
  Instagram,
  Facebook,
  Linkedin,
  UserPlus,
  Mail,
  Star,
  Info,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";

/**
 * Design: influencer status is a tinted pill. Literal hex — this project's
 * Tailwind config FLATTENS the blue-adjacent, green, amber and red scales onto
 * the palette's status triplets, so `bg-amber-100 text-amber-700` renders the
 * label the same colour as its own background.
 */
const INF_STATUS_STYLE: Record<string, string> = {
  discovered: "bg-[rgba(91,155,213,0.15)] text-[#5b9bd5]",
  shortlisted: "bg-[rgba(224,184,74,0.15)] text-[#e0b84a]",
  contacted: "bg-tile text-gold",
  responded: "bg-[rgba(92,184,92,0.15)] text-[#5cb85c]",
  engaged: "bg-[rgba(92,184,92,0.15)] text-[#5cb85c]",
  rejected: "bg-tile text-muted-foreground",
};

/** The design's compact count — "84.0K followers", "1.2K avg engagement". */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Platform glyph at the design's two sizes — 13px in feeds, 9px in chips. */
function platformIcon(platform: string, cls: string) {
  const Icon =
    platform === "TWITTER" ? Twitter
    : platform === "INSTAGRAM" ? Instagram
    : platform === "FACEBOOK" ? Facebook
    : platform === "LINKEDIN" ? Linkedin
    : Globe;
  return <Icon className={cls} />;
}

/** Shared pill classes for the segmented sub-tab row. */
const SUBTAB_BASE =
  "flex-1 shrink-0 whitespace-nowrap rounded-[8px] px-1 py-2 text-center text-[11px] leading-[1.3] transition-colors";
const SUBTAB_ON =
  "pa-gold-glow bg-gold font-semibold text-[hsl(var(--gold-foreground))]";
const SUBTAB_OFF =
  "font-medium text-muted-foreground hover:bg-hover hover:text-foreground";

/** The design's one gold CTA, right-aligned under the sub-tab row. */
const TAB_CTA =
  "pa-cta-gold h-[34px] gap-[7px] rounded-[9px] px-3.5 text-[12.5px] font-semibold";

type Tab = "campaigns" | "brands" | "content" | "influencers";

function CampaignsPageInner() {
  const [activeTab, setActiveTab] = useState<Tab>("campaigns");
  const [campaignDialogOpen, setCampaignDialogOpen] = useState(false);
  const [brandDialogOpen, setBrandDialogOpen] = useState(false);
  const [influencerDialogOpen, setInfluencerDialogOpen] = useState(false);

  // Campaign form
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [goalType, setGoalType] = useState("");

  // Brand form
  const [brandName, setBrandName] = useState("");
  const [brandDesc, setBrandDesc] = useState("");
  const [brandCampaignId, setBrandCampaignId] = useState("");
  const [twitterHandle, setTwitterHandle] = useState("");
  const [instagramHandle, setInstagramHandle] = useState("");
  const [facebookPageId, setFacebookPageId] = useState("");
  const [linkedinHandle, setLinkedinHandle] = useState("");
  const [tiktokHandle, setTiktokHandle] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");

  // Influencer form
  const [infName, setInfName] = useState("");
  const [infPlatform, setInfPlatform] = useState("TWITTER");
  const [infHandle, setInfHandle] = useState("");
  const [infEmail, setInfEmail] = useState("");
  const [infNotes, setInfNotes] = useState("");

  const { data: campaigns, isLoading: campaignsLoading } = trpc.campaign.list.useQuery();
  const { data: brands, isLoading: brandsLoading } = trpc.campaign.listBrands.useQuery();
  const { data: content, isLoading: contentLoading } = trpc.campaign.brandContent.useQuery({ limit: 50 });
  const { data: influencers, isLoading: influencersLoading } = trpc.campaign.listInfluencers.useQuery();
  const { data: infStats } = trpc.campaign.influencerStats.useQuery();

  const utils = trpc.useUtils();

  const createCampaign = trpc.campaign.create.useMutation({
    onSuccess: () => {
      utils.campaign.list.invalidate();
      setCampaignDialogOpen(false);
      setName(""); setDescription(""); setHashtags(""); setGoalType("");
    },
  });

  const setMonitoring = trpc.campaign.setMonitoring.useMutation({
    onSuccess: () => utils.campaign.list.invalidate(),
  });

  const deleteCampaign = trpc.campaign.delete.useMutation({
    onSuccess: () => utils.campaign.list.invalidate(),
  });

  const createBrand = trpc.campaign.createBrand.useMutation({
    onSuccess: () => {
      utils.campaign.listBrands.invalidate();
      setBrandDialogOpen(false);
      setBrandName(""); setBrandDesc(""); setBrandCampaignId("");
      setTwitterHandle(""); setInstagramHandle(""); setFacebookPageId("");
      setLinkedinHandle(""); setTiktokHandle(""); setWebsiteUrl("");
    },
  });

  const updateBrand = trpc.campaign.updateBrand.useMutation({
    onSuccess: () => utils.campaign.listBrands.invalidate(),
  });

  const deleteBrand = trpc.campaign.deleteBrand.useMutation({
    onSuccess: () => utils.campaign.listBrands.invalidate(),
  });

  const createInfluencer = trpc.campaign.createInfluencer.useMutation({
    onSuccess: () => {
      utils.campaign.listInfluencers.invalidate();
      utils.campaign.influencerStats.invalidate();
      setInfluencerDialogOpen(false);
      setInfName(""); setInfPlatform("TWITTER"); setInfHandle(""); setInfEmail(""); setInfNotes("");
    },
  });

  const updateInfluencer = trpc.campaign.updateInfluencer.useMutation({
    onSuccess: () => {
      utils.campaign.listInfluencers.invalidate();
      utils.campaign.influencerStats.invalidate();
    },
  });

  const deleteInfluencer = trpc.campaign.deleteInfluencer.useMutation({
    onSuccess: () => {
      utils.campaign.listInfluencers.invalidate();
      utils.campaign.influencerStats.invalidate();
    },
  });

  const totalCampaigns = campaigns?.length ?? 0;
  // "monitoring on" = at least one of the campaign's brand trackers is active
  // (derived server-side from tracker isActive — the real gate the sync cron reads).
  const monitoringCampaigns = campaigns?.filter((c) => c.monitoring).length ?? 0;
  const totalBrands = brands?.length ?? 0;
  const totalInfluencers = infStats?.total ?? 0;

  /* Design: the sub-tabs are label-only. The per-tab counts the app used to
     append are already the four stat cards directly above this row, so the
     pills repeated a number the reader had just seen. */
  const tabs: { key: Tab; label: string }[] = [
    { key: "campaigns", label: "Campaigns" },
    { key: "brands", label: "Brand Trackers" },
    { key: "content", label: "Content Feed" },
    { key: "influencers", label: "Influencers" },
  ];

  return (
    /* Design stacks sections on 20px, not 24px. */
    <div className="space-y-5">
      {/* Header — design: eyebrow, display headline, sub. The page CTA does NOT
          live here; each tab carries its own, right-aligned under the sub-tab
          row, so the button always names what the visible tab creates. */}
      <div className="min-w-0">
        <span className="eyebrow">Campaigns</span>
        <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
          Watch the market move.
        </h1>
        <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-muted-foreground">
          Monitor brands and competitors for new content, and discover influencers. Monitoring fetches their recent posts every ~6 hours. Campaigns don&apos;t schedule your own posts.
        </p>
      </div>
      {/* Design: a quiet surface-1 note, not the Alert component's framing. */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
        <Info className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
        <p className="text-[12px] leading-[1.65] text-muted-foreground">
          <b className="text-foreground">How Campaigns work:</b> track brands you want to follow,
          the influencers around them, and the content they release. Use Brand Trackers to add a
          brand; the system surfaces relevant posts in Content Feed. This is a monitoring tool for
          external brands — separate from your own posting, Approvals, and Brand Outreach.
        </p>
      </div>

      {/* Overview Stats — design: 3px accent rail + tinted 28px icon tile, a
          26px value and a 10.5px sub-line. Literal hex, because this project's
          Tailwind config flattens the blue/green/amber scales onto the
          palette's status triplets (a named shade would render each icon the
          same colour as its own tile). */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Campaigns", value: totalCampaigns, sub: `${monitoringCampaigns} monitoring on`, icon: Target, color: "hsl(var(--accent-gold))", tint: "hsl(var(--accent-gold) / 0.12)" },
          { title: "Brands Tracked", value: totalBrands, sub: "monitoring content", icon: Search, color: "#5b9bd5", tint: "rgba(91,155,213,0.12)" },
          { title: "Content Found", value: content?.length ?? 0, sub: "from all brands", icon: Globe, color: "#5cb85c", tint: "rgba(92,184,92,0.12)" },
          { title: "Influencers", value: totalInfluencers, sub: `${infStats?.shortlisted ?? 0} shortlisted`, icon: Users, color: "#e0b84a", tint: "rgba(224,184,74,0.12)" },
        ].map((stat) => (
          <div
            key={stat.title}
            className="relative overflow-hidden rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)]"
          >
            <span className="absolute left-0 top-0 h-full w-[3px]" style={{ background: stat.color }} />
            <div className="flex items-center justify-between gap-2.5">
              <span className="whitespace-nowrap text-[11px] font-medium leading-[1.3] text-muted-foreground">
                {stat.title}
              </span>
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]"
                style={{ background: stat.tint }}
              >
                <stat.icon className="h-[13px] w-[13px] shrink-0" style={{ color: stat.color }} />
              </div>
            </div>
            {campaignsLoading ? (
              <Skeleton className="mt-2.5 h-[26px] w-20" />
            ) : (
              <>
                <div className="mt-2.5 text-[26px] font-bold leading-none tracking-[-0.01em]">
                  {stat.value}
                </div>
                <div className="mt-[5px] text-[10.5px] leading-[1.3] text-faint">{stat.sub}</div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Sub-tabs — design: one segmented pill row on a surface-1 track, gold
          fill + halo on the active pill (the app had an underline row). Below
          `sm` it stays a scrollable row so every tab is reachable on a phone. */}
      <ScrollableTabRow
        role="tablist"
        className="gap-1 rounded-[11px] border border-border bg-surface1 p-1 sm:grid sm:grid-cols-4 sm:overflow-visible"
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`${SUBTAB_BASE} ${activeTab === tab.key ? SUBTAB_ON : SUBTAB_OFF}`}
          >
            <span className="block truncate">{tab.label}</span>
          </button>
        ))}
      </ScrollableTabRow>

      {/* Per-tab CTA, right-aligned under the sub-tabs (Content Feed has none —
          it is a read-only feed). */}
      <div className="flex justify-end">
        <div className="flex shrink-0 gap-2">
          {activeTab === "campaigns" && (
            <Dialog open={campaignDialogOpen} onOpenChange={setCampaignDialogOpen}>
              <DialogTrigger asChild>
                <Button className={TAB_CTA}><Plus className="h-[13px] w-[13px]" />New Campaign</Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader><DialogTitle>Create Campaign</DialogTitle></DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>Campaign Name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Q2 Brand Monitoring" />
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Campaign goals..." rows={2} />
                  </div>
                  <div>
                    <Label>Hashtags</Label>
                    <Input value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="#brand, #competitor (comma separated)" />
                  </div>
                  <div>
                    <Label>Goal Type</Label>
                    <select value={goalType} onChange={(e) => setGoalType(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                      <option value="">Select goal</option>
                      <option value="awareness">Brand Awareness</option>
                      <option value="engagement">Engagement</option>
                      <option value="influencer_discovery">Influencer Discovery</option>
                      <option value="competitive_analysis">Competitive Analysis</option>
                    </select>
                  </div>
                  <Button onClick={() => createCampaign.mutate({ name, description: description || undefined, hashtags: hashtags.split(",").map((h) => h.trim()).filter(Boolean), goalType: goalType || undefined })} disabled={!name || createCampaign.isPending} className="w-full">
                    {createCampaign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create Campaign
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
          {activeTab === "brands" && (
            <Dialog open={brandDialogOpen} onOpenChange={setBrandDialogOpen}>
              <DialogTrigger asChild>
                <Button className={TAB_CTA}><Plus className="h-[13px] w-[13px]" />Track Brand</Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Track New Brand</DialogTitle></DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>Brand Name</Label>
                    <Input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="e.g., Nike, Adidas" />
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea value={brandDesc} onChange={(e) => setBrandDesc(e.target.value)} placeholder="What does this brand do..." rows={2} />
                  </div>
                  {campaigns && campaigns.length > 0 && (
                    <div>
                      <Label>Link to Campaign (optional)</Label>
                      <select value={brandCampaignId} onChange={(e) => setBrandCampaignId(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                        <option value="">No campaign</option>
                        {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="border-t pt-4">
                    <p className="text-sm font-medium mb-3">Social Media Handles</p>
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Twitter className="h-4 w-4 text-muted-foreground shrink-0" />
                        <Input value={twitterHandle} onChange={(e) => setTwitterHandle(e.target.value)} placeholder="@handle" />
                      </div>
                      <div className="flex items-center gap-2">
                        <Instagram className="h-4 w-4 text-muted-foreground shrink-0" />
                        <Input value={instagramHandle} onChange={(e) => setInstagramHandle(e.target.value)} placeholder="@handle" />
                      </div>
                      <div className="flex items-center gap-2">
                        <Facebook className="h-4 w-4 text-muted-foreground shrink-0" />
                        <Input value={facebookPageId} onChange={(e) => setFacebookPageId(e.target.value)} placeholder="Page ID" />
                      </div>
                      <div className="flex items-center gap-2">
                        <Linkedin className="h-4 w-4 text-muted-foreground shrink-0" />
                        <Input value={linkedinHandle} onChange={(e) => setLinkedinHandle(e.target.value)} placeholder="Company ID" />
                      </div>
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                        <Input value={tiktokHandle} onChange={(e) => setTiktokHandle(e.target.value)} placeholder="@tiktok_handle" />
                      </div>
                    </div>
                  </div>
                  <div>
                    <Label>Website URL</Label>
                    <Input value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://brand.com" />
                  </div>
                  <Button onClick={() => createBrand.mutate({ brandName, description: brandDesc || undefined, campaignId: brandCampaignId || undefined, twitterHandle: twitterHandle || undefined, instagramHandle: instagramHandle || undefined, facebookPageId: facebookPageId || undefined, linkedinHandle: linkedinHandle || undefined, tiktokHandle: tiktokHandle || undefined, websiteUrl: websiteUrl || undefined })} disabled={!brandName || createBrand.isPending} className="w-full">
                    {createBrand.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Start Tracking
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
          {activeTab === "influencers" && (
            <Dialog open={influencerDialogOpen} onOpenChange={setInfluencerDialogOpen}>
              <DialogTrigger asChild>
                <Button className={TAB_CTA}><UserPlus className="h-[13px] w-[13px]" />Add Influencer</Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader><DialogTitle>Add Influencer Manually</DialogTitle></DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>Name</Label>
                    <Input value={infName} onChange={(e) => setInfName(e.target.value)} placeholder="Influencer name" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Platform</Label>
                      <select value={infPlatform} onChange={(e) => setInfPlatform(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                        <option value="TWITTER">Twitter/X</option>
                        <option value="INSTAGRAM">Instagram</option>
                        <option value="FACEBOOK">Facebook</option>
                        <option value="LINKEDIN">LinkedIn</option>
                        <option value="TIKTOK">TikTok</option>
                      </select>
                    </div>
                    <div>
                      <Label>Handle</Label>
                      <Input value={infHandle} onChange={(e) => setInfHandle(e.target.value)} placeholder="@handle" />
                    </div>
                  </div>
                  <div>
                    <Label>Contact Email (optional)</Label>
                    <Input value={infEmail} onChange={(e) => setInfEmail(e.target.value)} placeholder="email@example.com" />
                  </div>
                  <div>
                    <Label>Notes</Label>
                    <Textarea value={infNotes} onChange={(e) => setInfNotes(e.target.value)} placeholder="Why this influencer..." rows={2} />
                  </div>
                  <Button onClick={() => createInfluencer.mutate({ name: infName, platform: infPlatform, handle: infHandle.replace(/^@/, ""), contactEmail: infEmail || undefined, notes: infNotes || undefined })} disabled={!infName || !infHandle || createInfluencer.isPending} className="w-full">
                    {createInfluencer.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Add Influencer
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "campaigns" && (
        <div className="flex flex-col gap-2.5">
          {campaignsLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-[126px] rounded-[14px]" />)
          ) : campaigns && campaigns.length > 0 ? (
            campaigns.map((campaign) => (
              <div key={campaign.id} className="rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)] transition-colors hover:border-border2">
                <div className="flex flex-wrap items-start justify-between gap-3.5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-[9px]">
                      <Link href={`/dashboard/campaigns/${campaign.id}`} className="text-[14px] font-semibold leading-[1.3] hover:underline">
                        {campaign.name}
                      </Link>
                      {campaign.totalTrackers > 0 && (
                        <span
                          className={`shrink-0 rounded-full px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] ${
                            campaign.monitoring ? "bg-[rgba(92,184,92,0.15)] text-[#5cb85c]" : "bg-tile text-muted-foreground"
                          }`}
                        >
                          {campaign.monitoring ? `Monitoring ${campaign.activeTrackers}/${campaign.totalTrackers}` : "Monitoring off"}
                        </span>
                      )}
                    </div>
                    {campaign.description && (
                      <p className="mt-1.5 line-clamp-1 text-[12.5px] leading-[1.5] text-muted-foreground">{campaign.description}</p>
                    )}
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[11px] leading-none text-faint">
                      {campaign.hashtags.length > 0 && (
                        <span className="flex items-center gap-[5px]">
                          <Hash className="h-[11px] w-[11px]" />
                          {campaign.hashtags.slice(0, 3).join(", ")}
                          {campaign.hashtags.length > 3 && ` +${campaign.hashtags.length - 3}`}
                        </span>
                      )}
                      <span className="flex items-center gap-[5px]">
                        <Search className="h-[11px] w-[11px]" />
                        {campaign._count.brandTrackers} {campaign._count.brandTrackers === 1 ? "brand" : "brands"} tracked
                      </span>
                      <span className="flex items-center gap-[5px]">
                        <Calendar className="h-[11px] w-[11px]" />
                        Created {formatDistanceToNow(new Date(campaign.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {/* Monitoring toggle — flips isActive on ALL this campaign's brand
                        trackers, which is exactly what the brand-content-sync cron reads.
                        Disabled (with explanation) when there are no brands to monitor. */}
                    <div
                      className="flex items-center gap-3"
                      title={campaign.totalTrackers === 0 ? "Add a brand to monitor" : campaign.monitoring ? "Monitoring on — fetching new content ~6h" : "Monitoring off"}
                    >
                      <span className="text-[11px] leading-none text-muted-foreground">Monitoring</span>
                      <Switch
                        checked={campaign.monitoring}
                        disabled={campaign.totalTrackers === 0 || setMonitoring.isPending}
                        onCheckedChange={(enabled) => setMonitoring.mutate({ id: campaign.id, enabled })}
                        aria-label="Toggle monitoring for this campaign"
                      />
                    </div>
                    {(() => {
                      const deleting = deleteCampaign.isPending && deleteCampaign.variables?.id === campaign.id;
                      return (
                        <Button size="icon" variant="ghost" className="h-[26px] w-[26px] rounded-[6px] text-faint hover:bg-hover hover:text-[#c96b56]" aria-label={`Delete ${campaign.name}`} disabled={deleting} onClick={() => { if (confirm("Delete this campaign?")) deleteCampaign.mutate({ id: campaign.id }); }}>
                          {deleting ? <Loader2 className="h-[13px] w-[13px] animate-spin" /> : <Trash2 className="h-[13px] w-[13px]" />}
                        </Button>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="flex flex-col items-center justify-center rounded-[14px] border border-border bg-card px-4 py-12 text-center">
              <Target className="mb-4 h-12 w-12 text-muted-foreground/30" />
              <h3 className="text-[15px] font-semibold">No campaigns yet</h3>
              <p className="mt-1 max-w-sm text-[12.5px] leading-[1.5] text-muted-foreground">
                Create a campaign to group the brands and influencers you want to monitor.
              </p>
            </div>
          )}
        </div>
      )}

      {activeTab === "brands" && (
        <div className="flex flex-col gap-2.5">
          {brandsLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-[150px] rounded-[14px]" />)
          ) : brands && brands.length > 0 ? (
            brands.map((brand) => {
              /* Design: one chip per configured handle, built from a list so a
                 brand with two handles and one with six render identically. */
              const handles: { icon: typeof Twitter; label: string }[] = [];
              if (brand.twitterHandle) handles.push({ icon: Twitter, label: brand.twitterHandle });
              if (brand.instagramHandle) handles.push({ icon: Instagram, label: brand.instagramHandle });
              if (brand.facebookPageId) handles.push({ icon: Facebook, label: brand.facebookPageId });
              if (brand.linkedinHandle) handles.push({ icon: Linkedin, label: brand.linkedinHandle });
              if (brand.tiktokHandle) handles.push({ icon: Globe, label: brand.tiktokHandle });
              if (brand.websiteUrl) handles.push({ icon: ExternalLink, label: "Website" });
              const syncing = updateBrand.isPending && updateBrand.variables?.id === brand.id;
              const removing = deleteBrand.isPending && deleteBrand.variables?.id === brand.id;
              return (
                <div key={brand.id} className="rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)] transition-colors hover:border-border2">
                  <div className="flex flex-wrap items-start justify-between gap-3.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-[9px]">
                        <p className="text-[14px] font-semibold leading-[1.3]">{brand.brandName}</p>
                        <span
                          className={`shrink-0 rounded-full px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] ${
                            brand.isActive ? "bg-[rgba(92,184,92,0.15)] text-[#5cb85c]" : "bg-tile text-muted-foreground"
                          }`}
                        >
                          {brand.isActive ? "Active" : "Paused"}
                        </span>
                        <span className="text-[11px] leading-none text-faint">
                          {brand._count.contentItems} {brand._count.contentItems === 1 ? "content item" : "content items"}
                        </span>
                      </div>
                      {brand.description && (
                        <p className="mt-1.5 line-clamp-1 text-[12.5px] leading-[1.5] text-muted-foreground">{brand.description}</p>
                      )}
                      {handles.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-[7px]">
                          {handles.map((h) => (
                            <span
                              key={h.label}
                              className="flex items-center gap-[5px] rounded-[6px] border border-border2 px-[9px] py-0.5 text-[10.5px] font-medium leading-[1.6] text-muted-foreground"
                            >
                              <h.icon className="h-2.5 w-2.5" />
                              {h.label}
                            </span>
                          ))}
                        </div>
                      )}
                      {brand.lastSyncAt && (
                        <p className="mt-2.5 text-[10.5px] leading-none text-faint">
                          Last synced {formatDistanceToNow(new Date(brand.lastSyncAt), { addSuffix: true })}
                        </p>
                      )}
                    </div>
                    {/* Design groups the two row actions into one bordered pill on
                        surface-1, rather than two loose hover-only ghost buttons. */}
                    <div className="flex shrink-0 items-center rounded-[8px] border border-border bg-surface1 p-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-[26px] w-[26px] rounded-[6px] text-muted-foreground hover:bg-hover hover:text-foreground"
                        title={brand.isActive ? "Pause syncing" : "Resume syncing"}
                        aria-label={brand.isActive ? `Pause ${brand.brandName}` : `Resume ${brand.brandName}`}
                        disabled={syncing}
                        onClick={() => updateBrand.mutate({ id: brand.id, isActive: !brand.isActive })}
                      >
                        {syncing ? <Loader2 className="h-[13px] w-[13px] animate-spin" /> : brand.isActive ? <Pause className="h-[13px] w-[13px]" /> : <Play className="h-[13px] w-[13px]" />}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-[26px] w-[26px] rounded-[6px] text-faint hover:bg-hover hover:text-[#c96b56]"
                        aria-label={`Delete ${brand.brandName}`}
                        disabled={removing}
                        onClick={() => { if (confirm(`Delete brand tracker "${brand.brandName}"?`)) deleteBrand.mutate({ id: brand.id }); }}
                      >
                        {removing ? <Loader2 className="h-[13px] w-[13px] animate-spin" /> : <Trash2 className="h-[13px] w-[13px]" />}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center rounded-[14px] border border-border bg-card px-4 py-12 text-center">
              <Search className="mb-4 h-12 w-12 text-muted-foreground/30" />
              <h3 className="text-[15px] font-semibold">No brands tracked yet</h3>
              <p className="mt-1 max-w-sm text-[12.5px] leading-[1.5] text-muted-foreground">
                Add brands with their social media handles to start monitoring their content releases.
              </p>
            </div>
          )}
        </div>
      )}

      {activeTab === "content" && (
        <div className="flex flex-col gap-2.5">
          {contentLoading ? (
            [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[118px] rounded-[12px]" />)
          ) : content && content.length > 0 ? (
            content.map((item) => (
              <div key={item.id} className="rounded-[12px] border border-border bg-card p-4 transition-colors hover:border-border2">
                <div className="flex items-start gap-3">
                  {item.mediaUrl && (
                    <img src={item.mediaUrl} alt="" className="h-14 w-14 shrink-0 rounded-[10px] object-cover" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-muted-foreground">
                        {platformIcon(item.platform, "h-[13px] w-[13px]")}
                      </span>
                      <span className="text-[12px] font-semibold leading-none">{item.brandTracker?.brandName}</span>
                      {item.authorHandle && (
                        <span className="truncate text-[11px] leading-none text-muted-foreground">{item.authorHandle}</span>
                      )}
                      <span className="ml-auto shrink-0 text-[10.5px] leading-none text-faint">
                        {formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true })}
                      </span>
                    </div>
                    <p className="mt-[9px] line-clamp-2 text-[12.5px] leading-[1.55]">{item.content}</p>
                    <div className="mt-[9px] flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[11px] leading-none text-muted-foreground">
                      <span>{formatCompact(item.likes)} likes</span>
                      <span>{formatCompact(item.comments)} comments</span>
                      <span>{formatCompact(item.shares)} shares</span>
                      {item.views > 0 && <span>{formatCompact(item.views)} views</span>}
                      {item.contentUrl && (
                        <a href={item.contentUrl} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-gold hover:underline">
                          <ExternalLink className="h-[11px] w-[11px]" /> View
                        </a>
                      )}
                    </div>
                    {item.hashtags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {item.hashtags.slice(0, 5).map((tag) => (
                          <span key={tag} className="text-[10.5px] leading-[1.6] text-gold">#{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="flex flex-col items-center justify-center rounded-[12px] border border-border bg-card px-4 py-12 text-center">
              <Globe className="mb-4 h-12 w-12 text-muted-foreground/30" />
              <h3 className="text-[15px] font-semibold">No content found yet</h3>
              <p className="mt-1 max-w-sm text-[12.5px] leading-[1.5] text-muted-foreground">
                Content from tracked brands will appear here after the next sync cycle.
              </p>
            </div>
          )}
        </div>
      )}

      {activeTab === "influencers" && (
        <div className="space-y-4">
          {/* Influencer funnel stats */}
          {infStats && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Discovered", value: infStats.total, color: "#5b9bd5" },
                { label: "Shortlisted", value: infStats.shortlisted, color: "#e0b84a" },
                { label: "Contacted", value: infStats.contacted, color: "hsl(var(--accent-gold))" },
                { label: "Responded", value: infStats.responded, color: "#5cb85c" },
              ].map((s) => (
                <div key={s.label} className="rounded-[12px] border border-border bg-card p-3.5 text-center">
                  <div className="text-[20px] font-bold leading-none" style={{ color: s.color }}>
                    {s.value}
                  </div>
                  <div className="mt-[5px] text-[11px] leading-none text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            {influencersLoading ? (
              [1, 2, 3].map((i) => <Skeleton key={i} className="h-[86px] rounded-[14px]" />)
            ) : influencers && influencers.length > 0 ? (
              influencers.map((inf) => {
                const updating = updateInfluencer.isPending && updateInfluencer.variables?.id === inf.id;
                const removing = deleteInfluencer.isPending && deleteInfluencer.variables?.id === inf.id;
                /* Design: one "advance to the next stage" button, whose label and
                   glyph come from the influencer's CURRENT status. The app had
                   three near-identical buttons behind three conditionals. */
                const nextStep =
                  inf.status === "discovered" ? { to: "shortlisted", label: "Shortlist", Icon: Star }
                  : inf.status === "shortlisted" ? { to: "contacted", label: "Mark Contacted", Icon: Mail }
                  : inf.status === "contacted" ? { to: "responded", label: "Responded", Icon: Star }
                  : null;
                return (
                  <div key={inf.id} className="flex flex-wrap items-center gap-3.5 rounded-[14px] border border-border bg-card p-4 shadow-[0_6px_14px_-10px_rgba(0,0,0,.4)] transition-colors hover:border-border2">
                    {/* Design: influencer initial sits in a solid accent disc with
                        near-black initials — not the old pink gradient (which had
                        no `from-` stop, so it faded out of transparency). */}
                    <div className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-gold text-[14px] font-bold leading-none text-[hsl(var(--gold-foreground))]">
                      {inf.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-[220px] flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13.5px] font-semibold leading-[1.3]">{inf.name}</span>
                        <span className={`shrink-0 rounded-full px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] ${INF_STATUS_STYLE[inf.status] ?? "bg-tile text-muted-foreground"}`}>
                          {inf.status.charAt(0).toUpperCase() + inf.status.slice(1)}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 rounded-[5px] border border-border2 px-2 py-[1.5px] text-[9.5px] font-medium leading-[1.6] text-muted-foreground">
                          {platformIcon(inf.platform, "h-[9px] w-[9px]")}
                          {inf.platform}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-none text-faint">
                        <span className="truncate">@{inf.handle}</span>
                        <span className="whitespace-nowrap">{formatCompact(inf.followers)} followers</span>
                        <span className="whitespace-nowrap">{formatCompact(inf.avgEngagement)} avg engagement</span>
                        {inf.niche && <span className="truncate text-muted-foreground">{inf.niche}</span>}
                        {inf.relevanceScore > 0 && (
                          <span className="flex shrink-0 items-center gap-[3px]">
                            <Star className="h-2.5 w-2.5 text-gold" />
                            {inf.relevanceScore.toFixed(0)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {nextStep && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-[29px] gap-1.5 rounded-[8px] border-border2 bg-surface2 px-3 text-[11.5px] font-medium hover:bg-hover"
                          disabled={updating}
                          onClick={() => updateInfluencer.mutate({ id: inf.id, status: nextStep.to })}
                        >
                          {updating ? <Loader2 className="h-3 w-3 animate-spin" /> : <nextStep.Icon className="h-3 w-3" />}
                          {nextStep.label}
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-[27px] w-[27px] rounded-[6px] text-faint hover:bg-hover hover:text-[#c96b56]"
                        aria-label={`Remove ${inf.name}`}
                        disabled={removing}
                        onClick={() => { if (confirm(`Remove influencer "${inf.name}"?`)) deleteInfluencer.mutate({ id: inf.id }); }}
                      >
                        {removing ? <Loader2 className="h-[13px] w-[13px] animate-spin" /> : <Trash2 className="h-[13px] w-[13px]" />}
                      </Button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="flex flex-col items-center justify-center rounded-[14px] border border-border bg-card px-4 py-12 text-center">
                <Users className="mb-4 h-12 w-12 text-muted-foreground/30" />
                <h3 className="text-[15px] font-semibold">No influencers discovered yet</h3>
                <p className="mt-1 max-w-sm text-[12.5px] leading-[1.5] text-muted-foreground">
                  Influencers are auto-discovered from high-engagement brand content, or you can add them manually.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function CampaignsPage() {
  return (
    <RequireAppAdmin>
      <CampaignsPageInner />
    </RequireAppAdmin>
  );
}
