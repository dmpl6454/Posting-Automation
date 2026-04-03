"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
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
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  ArrowLeft,
  Plus,
  Search,
  Globe,
  Twitter,
  Instagram,
  Facebook,
  Linkedin,
  Users,
  ExternalLink,
  Hash,
  Trash2,
  Loader2,
  Star,
  Mail,
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

export default function CampaignDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [brandDialogOpen, setBrandDialogOpen] = useState(false);
  const [brandName, setBrandName] = useState("");
  const [twitterHandle, setTwitterHandle] = useState("");
  const [instagramHandle, setInstagramHandle] = useState("");
  const [facebookPageId, setFacebookPageId] = useState("");
  const [linkedinHandle, setLinkedinHandle] = useState("");
  const [tiktokHandle, setTiktokHandle] = useState("");

  const { data: campaign, isLoading } = trpc.campaign.byId.useQuery({ id });
  const { data: content, isLoading: contentLoading } = trpc.campaign.brandContent.useQuery({ campaignId: id, limit: 30 });
  const { data: influencers } = trpc.campaign.listInfluencers.useQuery();

  const utils = trpc.useUtils();

  const createBrand = trpc.campaign.createBrand.useMutation({
    onSuccess: () => {
      utils.campaign.byId.invalidate({ id });
      setBrandDialogOpen(false);
      setBrandName(""); setTwitterHandle(""); setInstagramHandle("");
      setFacebookPageId(""); setLinkedinHandle(""); setTiktokHandle("");
    },
  });

  const deleteBrand = trpc.campaign.deleteBrand.useMutation({
    onSuccess: () => utils.campaign.byId.invalidate({ id }),
  });

  const updateInfluencer = trpc.campaign.updateInfluencer.useMutation({
    onSuccess: () => utils.campaign.listInfluencers.invalidate(),
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (!campaign) return null;

  // Filter influencers related to this campaign's brands
  const brandNames = campaign.brandTrackers.map((b) => b.brandName.toLowerCase());
  const relatedInfluencers = influencers?.filter((inf) =>
    inf.niche && brandNames.includes(inf.niche.toLowerCase())
  ) ?? [];

  const totalContent = campaign.brandTrackers.reduce((s, b) => s + b._count.contentItems, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/dashboard/campaigns"
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Campaigns
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
          <Badge className={`text-xs ${statusColors[campaign.status] ?? ""}`}>{campaign.status}</Badge>
        </div>
        {campaign.description && (
          <p className="mt-1 text-sm text-muted-foreground">{campaign.description}</p>
        )}
        {campaign.hashtags.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {campaign.hashtags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                <Hash className="mr-1 h-3 w-3" />{tag}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Brands Tracked</CardTitle>
            <Search className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{campaign.brandTrackers.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Content Found</CardTitle>
            <Globe className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{totalContent}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Influencers Found</CardTitle>
            <Users className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{relatedInfluencers.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Brand Trackers */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Brand Trackers ({campaign.brandTrackers.length})</CardTitle>
          <Dialog open={brandDialogOpen} onOpenChange={setBrandDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="mr-1 h-3.5 w-3.5" />Add Brand</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>Track Brand in This Campaign</DialogTitle></DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Brand Name</Label>
                  <Input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="e.g., Nike" />
                </div>
                <div className="space-y-3">
                  <p className="text-sm font-medium">Social Handles</p>
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
                <Button onClick={() => createBrand.mutate({ brandName, campaignId: id, twitterHandle: twitterHandle || undefined, instagramHandle: instagramHandle || undefined, facebookPageId: facebookPageId || undefined, linkedinHandle: linkedinHandle || undefined, tiktokHandle: tiktokHandle || undefined })} disabled={!brandName || createBrand.isPending} className="w-full">
                  {createBrand.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Add Brand
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {campaign.brandTrackers.length > 0 ? (
            <div className="space-y-3">
              {campaign.brandTrackers.map((brand) => (
                <div key={brand.id} className="group flex items-center justify-between rounded-xl border border-border/30 bg-background/40 p-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold">{brand.brandName}</h4>
                      <span className="text-xs text-muted-foreground">{brand._count.contentItems} items</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {brand.twitterHandle && <Badge variant="outline" className="text-[10px] gap-1"><Twitter className="h-2.5 w-2.5" />{brand.twitterHandle}</Badge>}
                      {brand.instagramHandle && <Badge variant="outline" className="text-[10px] gap-1"><Instagram className="h-2.5 w-2.5" />{brand.instagramHandle}</Badge>}
                      {brand.facebookPageId && <Badge variant="outline" className="text-[10px] gap-1"><Facebook className="h-2.5 w-2.5" />{brand.facebookPageId}</Badge>}
                      {brand.linkedinHandle && <Badge variant="outline" className="text-[10px] gap-1"><Linkedin className="h-2.5 w-2.5" />{brand.linkedinHandle}</Badge>}
                      {brand.tiktokHandle && <Badge variant="outline" className="text-[10px] gap-1"><Globe className="h-2.5 w-2.5" />{brand.tiktokHandle}</Badge>}
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive opacity-0 group-hover:opacity-100" onClick={() => { if (confirm(`Remove "${brand.brandName}"?`)) deleteBrand.mutate({ id: brand.id }); }}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <Search className="mx-auto h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No brands tracked in this campaign yet.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content Feed */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Recent Content ({content?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {contentLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-16 mb-3 rounded-xl" />)
          ) : content && content.length > 0 ? (
            <div className="space-y-3">
              {content.map((item) => (
                <div key={item.id} className="flex items-start gap-3 rounded-xl border border-border/30 bg-background/40 p-3">
                  {item.mediaUrl && (
                    <img src={item.mediaUrl} alt="" className="h-12 w-12 rounded-lg object-cover shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {platformIcons[item.platform] || <Globe className="h-3 w-3" />}
                      <span className="text-xs font-medium">{item.brandTracker?.brandName}</span>
                      {item.authorHandle && <span className="text-xs text-muted-foreground">{item.authorHandle}</span>}
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        {formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true })}
                      </span>
                    </div>
                    <p className="text-sm line-clamp-2">{item.content}</p>
                    <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{item.likes} likes</span>
                      <span>{item.comments} comments</span>
                      <span>{item.shares} shares</span>
                      {item.contentUrl && (
                        <a href={item.contentUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 ml-auto">
                          <ExternalLink className="h-3 w-3" />View
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <Globe className="mx-auto h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No content found yet. Content will appear after the next sync.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Related Influencers */}
      {relatedInfluencers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Discovered Influencers ({relatedInfluencers.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {relatedInfluencers.map((inf) => (
                <div key={inf.id} className="group flex items-center gap-3 rounded-xl border border-border/30 bg-background/40 p-3">
                  <div className="h-9 w-9 rounded-full bg-gradient-to-br from-violet-500 to-pink-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                    {inf.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{inf.name}</span>
                      <Badge className={`text-[10px] ${influencerStatusColors[inf.status] ?? ""}`}>{inf.status}</Badge>
                      {platformIcons[inf.platform] || <Globe className="h-3 w-3" />}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>@{inf.handle}</span>
                      <span>{inf.followers.toLocaleString()} followers</span>
                      {inf.relevanceScore > 0 && (
                        <span className="flex items-center gap-0.5"><Star className="h-3 w-3 text-amber-500" />{inf.relevanceScore.toFixed(0)}</span>
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
                        <Mail className="mr-1 h-3 w-3" />Contact
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
