"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
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
  Eye,
  TrendingUp,
  Users,
  Hash,
  ExternalLink,
  Calendar,
  Loader2,
  Trash2,
  Pause,
  Play,
  Archive,
  Search,
  Globe,
  Twitter,
  Instagram,
  Facebook,
  Linkedin,
  ArrowLeft,
  UserPlus,
  Mail,
  Star,
  Filter,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";

const statusColors: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  ACTIVE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  PAUSED: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  COMPLETED: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  ARCHIVED: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500",
};

const influencerStatusColors: Record<string, string> = {
  discovered: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  shortlisted: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  contacted: "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
  responded: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  engaged: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

const platformIcons: Record<string, React.ReactNode> = {
  TWITTER: <Twitter className="h-3.5 w-3.5" />,
  INSTAGRAM: <Instagram className="h-3.5 w-3.5" />,
  FACEBOOK: <Facebook className="h-3.5 w-3.5" />,
  LINKEDIN: <Linkedin className="h-3.5 w-3.5" />,
  TIKTOK: <Globe className="h-3.5 w-3.5" />,
};

type Tab = "campaigns" | "brands" | "content" | "influencers";

export default function CampaignsPage() {
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

  const updateCampaign = trpc.campaign.update.useMutation({
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
  const activeCampaigns = campaigns?.filter((c) => c.status === "ACTIVE").length ?? 0;
  const totalBrands = brands?.length ?? 0;
  const totalInfluencers = infStats?.total ?? 0;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "campaigns", label: "Campaigns", count: totalCampaigns },
    { key: "brands", label: "Brand Trackers", count: totalBrands },
    { key: "content", label: "Content Feed", count: content?.length },
    { key: "influencers", label: "Influencers", count: totalInfluencers },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaign Tracking</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track brands, monitor their content releases, and discover key influencers
          </p>
        </div>
        <div className="flex gap-2">
          {activeTab === "campaigns" && (
            <Dialog open={campaignDialogOpen} onOpenChange={setCampaignDialogOpen}>
              <DialogTrigger asChild>
                <Button><Plus className="mr-2 h-4 w-4" />New Campaign</Button>
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
                <Button><Plus className="mr-2 h-4 w-4" />Track Brand</Button>
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
                <Button><UserPlus className="mr-2 h-4 w-4" />Add Influencer</Button>
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

      {/* Overview Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Campaigns", value: totalCampaigns, sub: `${activeCampaigns} active`, icon: Target, color: "text-violet-500" },
          { title: "Brands Tracked", value: totalBrands, sub: "monitoring content", icon: Search, color: "text-blue-500" },
          { title: "Content Found", value: content?.length ?? 0, sub: "from all brands", icon: Globe, color: "text-emerald-500" },
          { title: "Influencers", value: totalInfluencers, sub: `${infStats?.shortlisted ?? 0} shortlisted`, icon: Users, color: "text-amber-500" },
        ].map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{stat.title}</CardTitle>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              {campaignsLoading ? <Skeleton className="h-8 w-20" /> : (
                <>
                  <p className="text-2xl font-bold">{stat.value}</p>
                  <p className="text-xs text-muted-foreground">{stat.sub}</p>
                </>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border/50">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
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

      {/* Tab Content */}
      {activeTab === "campaigns" && (
        <div className="space-y-3">
          {campaignsLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)
          ) : campaigns && campaigns.length > 0 ? (
            campaigns.map((campaign) => (
              <div key={campaign.id} className="group rounded-2xl border border-border/40 bg-card/50 p-5 transition-all hover:border-border/60 hover:shadow-md">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <Link href={`/dashboard/campaigns/${campaign.id}`} className="text-base font-semibold hover:underline">
                        {campaign.name}
                      </Link>
                      <Badge className={`text-[10px] ${statusColors[campaign.status] ?? ""}`}>{campaign.status}</Badge>
                    </div>
                    {campaign.description && (
                      <p className="mt-1 text-sm text-muted-foreground line-clamp-1">{campaign.description}</p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      {campaign.hashtags.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Hash className="h-3 w-3" />
                          {campaign.hashtags.slice(0, 3).join(", ")}
                          {campaign.hashtags.length > 3 && ` +${campaign.hashtags.length - 3}`}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Search className="h-3 w-3" />
                        {campaign._count.brandTrackers} brands tracked
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        Created {formatDistanceToNow(new Date(campaign.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                  <div className="ml-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {campaign.status === "ACTIVE" ? (
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => updateCampaign.mutate({ id: campaign.id, status: "PAUSED" })}>
                        <Pause className="h-3.5 w-3.5" />
                      </Button>
                    ) : campaign.status === "PAUSED" || campaign.status === "DRAFT" ? (
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => updateCampaign.mutate({ id: campaign.id, status: "ACTIVE" })}>
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => updateCampaign.mutate({ id: campaign.id, status: "ARCHIVED" })}>
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => { if (confirm("Delete this campaign?")) deleteCampaign.mutate({ id: campaign.id }); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Target className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-semibold">No campaigns yet</h3>
                <p className="mt-1 text-sm text-muted-foreground max-w-sm">
                  Create a campaign to group and organize your brand tracking efforts.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === "brands" && (
        <div className="space-y-3">
          {brandsLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)
          ) : brands && brands.length > 0 ? (
            brands.map((brand) => (
              <div key={brand.id} className="group rounded-2xl border border-border/40 bg-card/50 p-5 transition-all hover:border-border/60 hover:shadow-md">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <h3 className="text-base font-semibold">{brand.brandName}</h3>
                      <Badge className={brand.isActive ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300" : "bg-gray-100 text-gray-500"}>
                        {brand.isActive ? "Active" : "Paused"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {brand._count.contentItems} content items
                      </span>
                    </div>
                    {brand.description && (
                      <p className="mt-1 text-sm text-muted-foreground line-clamp-1">{brand.description}</p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {brand.twitterHandle && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <Twitter className="h-3 w-3" /> {brand.twitterHandle}
                        </Badge>
                      )}
                      {brand.instagramHandle && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <Instagram className="h-3 w-3" /> {brand.instagramHandle}
                        </Badge>
                      )}
                      {brand.facebookPageId && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <Facebook className="h-3 w-3" /> {brand.facebookPageId}
                        </Badge>
                      )}
                      {brand.linkedinHandle && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <Linkedin className="h-3 w-3" /> {brand.linkedinHandle}
                        </Badge>
                      )}
                      {brand.tiktokHandle && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <Globe className="h-3 w-3" /> {brand.tiktokHandle}
                        </Badge>
                      )}
                      {brand.websiteUrl && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <ExternalLink className="h-3 w-3" /> Website
                        </Badge>
                      )}
                    </div>
                    {brand.lastSyncAt && (
                      <p className="mt-2 text-[10px] text-muted-foreground">
                        Last synced {formatDistanceToNow(new Date(brand.lastSyncAt), { addSuffix: true })}
                      </p>
                    )}
                  </div>
                  <div className="ml-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => { if (confirm(`Delete brand tracker "${brand.brandName}"?`)) deleteBrand.mutate({ id: brand.id }); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Search className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-semibold">No brands tracked yet</h3>
                <p className="mt-1 text-sm text-muted-foreground max-w-sm">
                  Add brands with their social media handles to start monitoring their content releases.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === "content" && (
        <div className="space-y-3">
          {contentLoading ? (
            [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 rounded-2xl" />)
          ) : content && content.length > 0 ? (
            content.map((item) => (
              <div key={item.id} className="rounded-2xl border border-border/40 bg-card/50 p-4 transition-all hover:border-border/60 hover:shadow-sm">
                <div className="flex items-start gap-3">
                  {item.mediaUrl && (
                    <img src={item.mediaUrl} alt="" className="h-14 w-14 rounded-lg object-cover shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {platformIcons[item.platform] || <Globe className="h-3.5 w-3.5" />}
                      <span className="text-xs font-medium">{item.brandTracker?.brandName}</span>
                      {item.authorHandle && (
                        <span className="text-xs text-muted-foreground">{item.authorHandle}</span>
                      )}
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        {formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true })}
                      </span>
                    </div>
                    <p className="text-sm line-clamp-2">{item.content}</p>
                    <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                      <span>{item.likes.toLocaleString()} likes</span>
                      <span>{item.comments.toLocaleString()} comments</span>
                      <span>{item.shares.toLocaleString()} shares</span>
                      {item.views > 0 && <span>{item.views.toLocaleString()} views</span>}
                      {item.contentUrl && (
                        <a href={item.contentUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-blue-600 hover:underline ml-auto">
                          <ExternalLink className="h-3 w-3" /> View
                        </a>
                      )}
                    </div>
                    {item.hashtags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {item.hashtags.slice(0, 5).map((tag) => (
                          <span key={tag} className="text-[10px] text-blue-600">#{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Globe className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-semibold">No content found yet</h3>
                <p className="mt-1 text-sm text-muted-foreground max-w-sm">
                  Content from tracked brands will appear here after the next sync cycle.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === "influencers" && (
        <div className="space-y-4">
          {/* Influencer funnel stats */}
          {infStats && (
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                { label: "Discovered", value: infStats.total, color: "text-blue-500" },
                { label: "Shortlisted", value: infStats.shortlisted, color: "text-amber-500" },
                { label: "Contacted", value: infStats.contacted, color: "text-violet-500" },
                { label: "Responded", value: infStats.responded, color: "text-emerald-500" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-border/40 bg-card/50 p-3 text-center">
                  <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-3">
            {influencersLoading ? (
              [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-2xl" />)
            ) : influencers && influencers.length > 0 ? (
              influencers.map((inf) => (
                <div key={inf.id} className="group rounded-2xl border border-border/40 bg-card/50 p-4 transition-all hover:border-border/60 hover:shadow-sm">
                  <div className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-violet-500 to-pink-500 flex items-center justify-center text-white text-sm font-bold shrink-0">
                      {inf.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-semibold">{inf.name}</h4>
                        <Badge className={`text-[10px] ${influencerStatusColors[inf.status] ?? ""}`}>
                          {inf.status}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] gap-1">
                          {platformIcons[inf.platform] || <Globe className="h-3 w-3" />}
                          {inf.platform}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>@{inf.handle}</span>
                        <span>{inf.followers.toLocaleString()} followers</span>
                        <span>{inf.avgEngagement.toFixed(0)} avg engagement</span>
                        {inf.niche && <span className="text-blue-600">{inf.niche}</span>}
                        {inf.relevanceScore > 0 && (
                          <span className="flex items-center gap-0.5">
                            <Star className="h-3 w-3 text-amber-500" />
                            {inf.relevanceScore.toFixed(0)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {inf.status === "discovered" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateInfluencer.mutate({ id: inf.id, status: "shortlisted" })}>
                          Shortlist
                        </Button>
                      )}
                      {inf.status === "shortlisted" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateInfluencer.mutate({ id: inf.id, status: "contacted" })}>
                          <Mail className="mr-1 h-3 w-3" /> Mark Contacted
                        </Button>
                      )}
                      {inf.status === "contacted" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateInfluencer.mutate({ id: inf.id, status: "responded" })}>
                          Responded
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => { if (confirm(`Remove influencer "${inf.name}"?`)) deleteInfluencer.mutate({ id: inf.id }); }}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <Users className="h-12 w-12 text-muted-foreground/30 mb-4" />
                  <h3 className="text-lg font-semibold">No influencers discovered yet</h3>
                  <p className="mt-1 text-sm text-muted-foreground max-w-sm">
                    Influencers are auto-discovered from high-engagement brand content, or you can add them manually.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
