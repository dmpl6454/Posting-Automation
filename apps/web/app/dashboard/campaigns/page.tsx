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
  BarChart3,
  Eye,
  MousePointerClick,
  Users,
  TrendingUp,
  DollarSign,
  Hash,
  ExternalLink,
  Calendar,
  Loader2,
  Trash2,
  Pause,
  Play,
  Archive,
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

export default function CampaignsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [trackingUrls, setTrackingUrls] = useState("");
  const [budget, setBudget] = useState("");
  const [goalType, setGoalType] = useState("");

  const { data: campaigns, isLoading } = trpc.campaign.list.useQuery();
  const utils = trpc.useUtils();

  const createMutation = trpc.campaign.create.useMutation({
    onSuccess: () => {
      utils.campaign.list.invalidate();
      setDialogOpen(false);
      setName("");
      setDescription("");
      setHashtags("");
      setTrackingUrls("");
      setBudget("");
      setGoalType("");
    },
  });

  const updateMutation = trpc.campaign.update.useMutation({
    onSuccess: () => utils.campaign.list.invalidate(),
  });

  const deleteMutation = trpc.campaign.delete.useMutation({
    onSuccess: () => utils.campaign.list.invalidate(),
  });

  const handleCreate = () => {
    createMutation.mutate({
      name,
      description: description || undefined,
      hashtags: hashtags
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
      trackingUrls: trackingUrls
        .split("\n")
        .map((u) => u.trim())
        .filter(Boolean),
      budget: budget ? parseFloat(budget) : undefined,
      goalType: goalType || undefined,
    });
  };

  // Aggregate stats across all campaigns
  const totalCampaigns = campaigns?.length ?? 0;
  const activeCampaigns = campaigns?.filter((c) => c.status === "ACTIVE").length ?? 0;
  const totalImpressions = campaigns?.reduce((s, c) => s + c.totalImpressions, 0) ?? 0;
  const totalEngagements = campaigns?.reduce((s, c) => s + c.totalEngagements, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaign Tracking</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track and monitor your external marketing campaigns
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Track Campaign
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Track New Campaign</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Campaign Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Summer Sale 2026"
                />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Campaign goals and details..."
                  rows={2}
                />
              </div>
              <div>
                <Label>Hashtags to Track</Label>
                <Input
                  value={hashtags}
                  onChange={(e) => setHashtags(e.target.value)}
                  placeholder="#SummerSale, #BrandName (comma separated)"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Track mentions and performance of these hashtags
                </p>
              </div>
              <div>
                <Label>Tracking URLs / UTM Links</Label>
                <Textarea
                  value={trackingUrls}
                  onChange={(e) => setTrackingUrls(e.target.value)}
                  placeholder="https://example.com?utm_campaign=summer&#10;One URL per line"
                  rows={2}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Budget ($)</Label>
                  <Input
                    type="number"
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    placeholder="5000"
                  />
                </div>
                <div>
                  <Label>Goal Type</Label>
                  <select
                    value={goalType}
                    onChange={(e) => setGoalType(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Select goal</option>
                    <option value="awareness">Brand Awareness</option>
                    <option value="engagement">Engagement</option>
                    <option value="traffic">Traffic</option>
                    <option value="conversions">Conversions</option>
                  </select>
                </div>
              </div>
              <Button
                onClick={handleCreate}
                disabled={!name || createMutation.isPending}
                className="w-full"
              >
                {createMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Start Tracking
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Overview Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Total Campaigns", value: totalCampaigns, icon: Target, color: "text-violet-500" },
          { title: "Active", value: activeCampaigns, icon: Play, color: "text-emerald-500" },
          { title: "Total Impressions", value: totalImpressions.toLocaleString(), icon: Eye, color: "text-blue-500" },
          { title: "Total Engagements", value: totalEngagements.toLocaleString(), icon: TrendingUp, color: "text-amber-500" },
        ].map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.title}
              </CardTitle>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-2xl font-bold">{stat.value}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Campaign List */}
      <div className="space-y-3">
        {isLoading ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)
        ) : campaigns && campaigns.length > 0 ? (
          campaigns.map((campaign) => (
            <div
              key={campaign.id}
              className="group rounded-2xl border border-border/40 bg-card/50 p-5 transition-all hover:border-border/60 hover:shadow-md"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <Link
                      href={`/dashboard/campaigns/${campaign.id}`}
                      className="text-base font-semibold hover:underline"
                    >
                      {campaign.name}
                    </Link>
                    <Badge className={`text-[10px] ${statusColors[campaign.status] ?? ""}`}>
                      {campaign.status}
                    </Badge>
                  </div>
                  {campaign.description && (
                    <p className="mt-1 text-sm text-muted-foreground line-clamp-1">
                      {campaign.description}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    {campaign.hashtags.length > 0 && (
                      <span className="flex items-center gap-1">
                        <Hash className="h-3 w-3" />
                        {campaign.hashtags.slice(0, 3).join(", ")}
                        {campaign.hashtags.length > 3 && ` +${campaign.hashtags.length - 3}`}
                      </span>
                    )}
                    {campaign.budget && (
                      <span className="flex items-center gap-1">
                        <DollarSign className="h-3 w-3" />
                        {campaign.currency} {campaign.budget.toLocaleString()}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <BarChart3 className="h-3 w-3" />
                      {campaign._count.campaignPosts} posts tracked
                    </span>
                    {campaign.startDate && (
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        Started {formatDistanceToNow(new Date(campaign.startDate), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                </div>

                {/* Metrics summary */}
                <div className="hidden sm:flex items-center gap-6 text-center">
                  <div>
                    <p className="text-lg font-semibold">{campaign.totalImpressions.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">Impressions</p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold">{campaign.totalEngagements.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">Engagements</p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold">{campaign.totalClicks.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">Clicks</p>
                  </div>
                </div>

                {/* Actions */}
                <div className="ml-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {campaign.status === "ACTIVE" ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => updateMutation.mutate({ id: campaign.id, status: "PAUSED" })}
                    >
                      <Pause className="h-3.5 w-3.5" />
                    </Button>
                  ) : campaign.status === "PAUSED" || campaign.status === "DRAFT" ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => updateMutation.mutate({ id: campaign.id, status: "ACTIVE" })}
                    >
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => updateMutation.mutate({ id: campaign.id, status: "ARCHIVED" })}
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive"
                    onClick={() => {
                      if (confirm("Delete this campaign?")) {
                        deleteMutation.mutate({ id: campaign.id });
                      }
                    }}
                  >
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
              <h3 className="text-lg font-semibold">No campaigns tracked yet</h3>
              <p className="mt-1 text-sm text-muted-foreground max-w-sm">
                Start tracking your external marketing campaigns by adding hashtags, UTM links, and budget goals.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
