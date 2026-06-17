"use client";

import { humanizeError } from "~/lib/errors";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { DateTimePicker } from "~/components/ui/datetime-picker";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import {
  ArrowLeft,
  PenSquare,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  AlertCircle,
  Save,
  Send,
  Trash2,
  ExternalLink,
  ImageIcon,
  Tag,
  CalendarIcon,
  RotateCcw,
  Ban,
  Plus,
} from "lucide-react";
import { format } from "date-fns";

const statusConfig: Record<
  string,
  { color: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: any }
> = {
  DRAFT: { color: "bg-gray-100 text-gray-700", variant: "secondary", icon: PenSquare },
  SCHEDULED: { color: "bg-blue-100 text-blue-700", variant: "outline", icon: Clock },
  PUBLISHING: { color: "bg-yellow-100 text-yellow-700", variant: "outline", icon: Loader2 },
  PUBLISHED: { color: "bg-green-100 text-green-700", variant: "default", icon: CheckCircle },
  FAILED: { color: "bg-red-100 text-red-700", variant: "destructive", icon: XCircle },
  CANCELLED: { color: "bg-gray-100 text-gray-500", variant: "secondary", icon: AlertCircle },
};

export default function PostDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const postId = params.id as string;
  // Per-target SSE-driven progress: postTargetId → percent (0-100)
  const [liveProgress, setLiveProgress] = useState<Record<string, number>>({});

  const isPublishing = (post: any) =>
    post?.status === "PUBLISHING" || post?.targets?.some((t: any) => t.status === "PUBLISHING");

  const { data: post, isLoading, refetch } = trpc.post.getById.useQuery(
    { id: postId },
    // Poll every 2s while any target is PUBLISHING so status changes appear quickly.
    { refetchInterval: (query) => (isPublishing((query as any).state?.data) ? 2000 : false) }
  );

  // Subscribe to SSE progress events for each PUBLISHING target
  useEffect(() => {
    if (!post?.targets) return;
    const publishingTargets = post.targets.filter((t: any) => t.status === "PUBLISHING");
    if (publishingTargets.length === 0) return;

    const sources: EventSource[] = [];
    for (const target of publishingTargets) {
      const es = new EventSource(`/api/progress?id=${target.id}`);
      es.onmessage = (e) => {
        try {
          const { percent } = JSON.parse(e.data);
          if (typeof percent === "number") {
            setLiveProgress((prev) => ({ ...prev, [target.id]: percent }));
            // Once at 100, trigger a final refetch so status flips to PUBLISHED
            if (percent >= 100) refetch();
          }
        } catch {}
      };
      es.onerror = () => es.close();
      sources.push(es);
    }
    return () => sources.forEach((es) => es.close());
  }, [post?.targets?.map((t: any) => t.id + t.status).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [hasChanges, setHasChanges] = useState(false);

  // Sync local state when post data loads
  useEffect(() => {
    if (post) {
      setContent(post.content);
      setTags(post.tags.map((t: any) => t.tag).join(", "));
      setScheduledAt(
        post.scheduledAt
          ? new Date(post.scheduledAt).toISOString().slice(0, 16)
          : ""
      );
      setHasChanges(false);
    }
  }, [post]);

  const isEditable = post?.status === "DRAFT" || post?.status === "SCHEDULED";

  // Channels not yet targeted by this post — offered as one-click "Add"
  // buttons on editable (draft/scheduled) posts, so a channel-less draft
  // saved from Content Studio can be given channels here.
  const { data: allChannels } = trpc.channel.list.useQuery(undefined, { enabled: isEditable });
  const [addingChannelId, setAddingChannelId] = useState<string | null>(null);
  const targetedChannelIds = new Set((post?.targets ?? []).map((t: any) => t.channelId));
  const addableChannels = (allChannels ?? []).filter((c: any) => !targetedChannelIds.has(c.id));

  const handleAddChannel = (channelId: string) => {
    setAddingChannelId(channelId);
    updatePost.mutate(
      { id: postId, channelIds: [...targetedChannelIds, channelId] as string[] },
      { onSettled: () => setAddingChannelId(null) }
    );
  };

  const updatePost = trpc.post.update.useMutation({
    onSuccess: () => {
      toast({ title: "Post updated", description: "Your changes have been saved." });
      setHasChanges(false);
      refetch();
    },
    onError: (err) => {
      toast({ title: "Update failed", description: humanizeError(err), variant: "destructive" });
    },
  });

  const deletePost = trpc.post.delete.useMutation({
    onSuccess: () => {
      toast({ title: "Post deleted", description: "The post has been removed." });
      router.push("/dashboard/posts");
    },
    onError: (err) => {
      toast({ title: "Delete failed", description: humanizeError(err), variant: "destructive" });
    },
  });

  const publishNow = trpc.post.publishNow.useMutation({
    onSuccess: () => {
      toast({ title: "Publishing started", description: "Publishing to selected channels." });
      refetch();
    },
    onError: (err) => {
      toast({ title: "Publish failed", description: humanizeError(err), variant: "destructive" });
    },
  });

  const [retryingTargetId, setRetryingTargetId] = useState<string | null>(null);

  // ── Submit for review (APPR-1) ──────────────────────────────────────────────
  const [reviewerOpen, setReviewerOpen] = useState(false);
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const { data: teamMembers } = trpc.team.members.useQuery(undefined, {
    enabled: post?.status === "DRAFT",
  });
  const submitForReview = trpc.approval.submit.useMutation({
    onSuccess: () => {
      toast({ title: "Sent for review", description: "Reviewers have been notified." });
      setReviewerOpen(false);
      setReviewerIds([]);
      refetch();
    },
    onError: (err) => toast({ title: "Couldn't submit", description: humanizeError(err), variant: "destructive" }),
  });
  // ────────────────────────────────────────────────────────────────────────────

  const handleRetryTarget = (targetId: string) => {
    setRetryingTargetId(targetId);
    publishNow.mutate(
      { id: postId, targetIds: [targetId] },
      { onSettled: () => setRetryingTargetId(null) }
    );
  };

  const handleSave = () => {
    const parsedTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    updatePost.mutate({
      id: postId,
      content,
      tags: parsedTags,
      scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
    });
  };

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete this post? This action cannot be undone.")) {
      deletePost.mutate({ id: postId });
    }
  };

  const handlePublishAll = () => {
    const eligible = post?.targets.filter((t: any) => t.status === "FAILED" || t.status === "DRAFT" || t.status === "SCHEDULED") ?? [];
    if (eligible.length === 0) return;
    const msg = `Publish to ${eligible.length} channel${eligible.length !== 1 ? "s" : ""}?`;
    if (confirm(msg)) {
      publishNow.mutate({ id: postId, targetIds: eligible.map((t: any) => t.id) });
    }
  };

  const handleCancelSchedule = () => {
    updatePost.mutate({
      id: postId,
      scheduledAt: null,
    });
  };

  const handleContentChange = (value: string) => {
    setContent(value);
    setHasChanges(true);
  };

  const handleTagsChange = (value: string) => {
    setTags(value);
    setHasChanges(true);
  };

  const handleScheduleChange = (value: string) => {
    setScheduledAt(value);
    setHasChanges(true);
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-5" />
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-6 w-20" />
        </div>
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  // Post not found
  if (!post) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <AlertCircle className="h-12 w-12 text-muted-foreground/30" />
            <h3 className="mt-4 text-lg font-medium">Post not found</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This post may have been deleted or you don&apos;t have access to it.
            </p>
            <Button asChild className="mt-4" variant="outline">
              <Link href="/dashboard/posts">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Posts
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const config = statusConfig[post.status] ?? statusConfig.DRAFT!;
  const StatusIcon = config!.icon;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/dashboard/posts"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Posts
        </Link>
      </div>

      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Post Details</h1>
            <Badge variant={config.variant} className="gap-1">
              <StatusIcon className={`h-3 w-3 ${post.status === "PUBLISHING" ? "animate-spin" : ""}`} />
              {post.status.charAt(0) + post.status.slice(1).toLowerCase()}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Created {format(new Date(post.createdAt), "MMM d, yyyy 'at' h:mm a")}
            {post.publishedAt && (
              <> &middot; Published {format(new Date(post.publishedAt), "MMM d, yyyy 'at' h:mm a")}</>
            )}
          </p>
        </div>
        {post.aiGenerated && (
          <Badge variant="outline" className="gap-1 text-purple-600 border-purple-200 bg-purple-50">
            AI Generated
          </Badge>
        )}
      </div>

      {/* Content Editor */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Content</CardTitle>
          {!isEditable && (
            <CardDescription>
              This post is {post.status.toLowerCase()} and cannot be edited.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {isEditable ? (
            <>
              <Textarea
                value={content}
                onChange={(e) => handleContentChange(e.target.value)}
                className="min-h-[200px] resize-none"
                placeholder="Post content..."
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{content.length} characters</span>
                {hasChanges && (
                  <span className="text-amber-600 font-medium">Unsaved changes</span>
                )}
              </div>
            </>
          ) : (
            <div className="whitespace-pre-wrap rounded-lg bg-muted/50 p-4 text-sm leading-relaxed">
              {post.content}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Channel Targets */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Channels</CardTitle>
          <CardDescription>
            {post.targets.length} channel{post.targets.length !== 1 ? "s" : ""} targeted
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {post.targets.map((target: any) => {
              const targetConfig = statusConfig[target.status] ?? statusConfig.DRAFT!;
              const TargetStatusIcon = targetConfig!.icon;
              return (
                <div
                  key={target.id}
                  className="rounded-lg border p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                      <TargetStatusIcon
                        className={`h-4 w-4 text-muted-foreground ${
                          target.status === "PUBLISHING" ? "animate-spin" : ""
                        }`}
                      />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{target.channel.name}</p>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          {target.channel.platform}
                        </Badge>
                        {target.channel.username && (
                          <span className="text-xs text-muted-foreground">
                            @{target.channel.username}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={targetConfig.variant} className="text-xs">
                      {target.status.charAt(0) + target.status.slice(1).toLowerCase()}
                    </Badge>
                    {(target.status === "FAILED" || target.status === "DRAFT" || target.status === "SCHEDULED") && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => handleRetryTarget(target.id)}
                        disabled={retryingTargetId === target.id}
                      >
                        {retryingTargetId === target.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : target.status === "FAILED" ? (
                          <RotateCcw className="h-3 w-3" />
                        ) : (
                          <Send className="h-3 w-3" />
                        )}
                        <span className="ml-1">{target.status === "FAILED" ? "Retry" : "Publish"}</span>
                      </Button>
                    )}
                    {target.publishedUrl && (
                      <a
                        href={target.publishedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        View
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  </div>
                  {/* Upload progress bar — live via SSE; falls back to DB-polled value */}
                  {target.status === "PUBLISHING" && (() => {
                    const pct = liveProgress[target.id] ?? target.uploadProgress;
                    if (pct != null) {
                      return (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>Uploading…</span>
                            <span>{pct}%</span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-all duration-300"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Publishing…</div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div className="h-full w-full rounded-full bg-primary/40 animate-pulse" />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })}

            {/* Show error messages for failed targets */}
            {post.targets
              .filter((t: any) => t.status === "FAILED" && t.errorMessage)
              .map((target: any) => (
                <div
                  key={`error-${target.id}`}
                  className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3"
                >
                  <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
                  <div>
                    <p className="text-xs font-medium text-red-700">
                      {target.channel.name} ({target.channel.platform})
                    </p>
                    <p className="mt-0.5 text-xs text-red-600">{target.errorMessage}</p>
                    {target.retryCount > 0 && (
                      <p className="mt-1 text-xs text-red-400">
                        Retried {target.retryCount} time{target.retryCount !== 1 ? "s" : ""}
                      </p>
                    )}
                  </div>
                </div>
              ))}

            {/* Add channels — drafts/scheduled only. A channel-less draft (saved
                from Content Studio without selecting channels) gets its channels
                here before it can be published. */}
            {isEditable && addableChannels.length > 0 && (
              <div className="rounded-lg border border-dashed p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  {post.targets.length === 0
                    ? "This draft has no channels yet — add at least one to publish it."
                    : "Add more channels:"}
                </p>
                <div className="flex flex-wrap gap-2">
                  {addableChannels.map((channel: any) => (
                    <Button
                      key={channel.id}
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={addingChannelId === channel.id || updatePost.isPending}
                      onClick={() => handleAddChannel(channel.id)}
                    >
                      {addingChannelId === channel.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Plus className="h-3 w-3" />
                      )}
                      {channel.name}
                      <Badge variant="secondary" className="ml-1 text-[9px]">
                        {channel.platform}
                      </Badge>
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Media Attachments */}
      {post.mediaAttachments.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ImageIcon className="h-4 w-4" />
              Media
            </CardTitle>
            <CardDescription>
              {post.mediaAttachments.length} file{post.mediaAttachments.length !== 1 ? "s" : ""} attached
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {post.mediaAttachments.map((attachment: any) => (
                <div
                  key={attachment.id}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  {attachment.media.fileType?.startsWith("video/") ? (
                    <video
                      src={`${attachment.media.url}#t=0.5`}
                      className="h-14 w-14 rounded-md object-cover bg-muted"
                      muted
                      preload="metadata"
                      playsInline
                    />
                  ) : attachment.media.url ? (
                    <img
                      src={attachment.media.url}
                      alt={attachment.media.fileName}
                      className="h-14 w-14 rounded-md object-cover"
                    />
                  ) : (
                    <div className="flex h-14 w-14 items-center justify-center rounded-md bg-muted">
                      <ImageIcon className="h-6 w-6 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{attachment.media.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {attachment.media.fileType}
                      {attachment.media.width && attachment.media.height && (
                        <> &middot; {attachment.media.width}x{attachment.media.height}</>
                      )}
                      {attachment.media.fileSize && (
                        <> &middot; {(attachment.media.fileSize / 1024).toFixed(0)} KB</>
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tags */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Tag className="h-4 w-4" />
            Tags
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isEditable ? (
            <div className="space-y-2">
              <Input
                value={tags}
                onChange={(e) => handleTagsChange(e.target.value)}
                placeholder="Enter tags separated by commas (e.g. marketing, launch, product)"
              />
              <p className="text-xs text-muted-foreground">
                Separate tags with commas
              </p>
            </div>
          ) : post.tags.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {post.tags.map((t: any) => (
                <Badge key={t.id} variant="secondary">
                  {t.tag}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No tags</p>
          )}
        </CardContent>
      </Card>

      {/* Schedule */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarIcon className="h-4 w-4" />
            Schedule
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isEditable ? (
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <Label htmlFor="schedule-date" className="sr-only">
                  Schedule date
                </Label>
                <DateTimePicker
                  id="schedule-date"
                  value={scheduledAt}
                  onChange={handleScheduleChange}
                  min={new Date().toISOString().slice(0, 16)}
                />
              </div>
              {scheduledAt && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleScheduleChange("")}
                  className="text-muted-foreground"
                >
                  Clear
                </Button>
              )}
            </div>
          ) : post.scheduledAt ? (
            <p className="text-sm">
              {post.status === "PUBLISHED" ? "Was scheduled for " : "Scheduled for "}
              <span className="font-medium">
                {format(new Date(post.scheduledAt), "EEEE, MMMM d, yyyy 'at' h:mm a")}
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No schedule set</p>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-3 pb-8">
        <div>
          {/* Delete — available for DRAFT, SCHEDULED, FAILED, CANCELLED */}
          {post.status !== "PUBLISHED" && post.status !== "PUBLISHING" && (
            <Button
              variant="outline"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleDelete}
              disabled={deletePost.isPending}
            >
              {deletePost.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete
            </Button>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Save — only for editable posts */}
          {isEditable && (
            <Button
              variant="outline"
              onClick={handleSave}
              disabled={updatePost.isPending || !hasChanges}
            >
              {updatePost.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save Changes
            </Button>
          )}

          {/* Cancel Schedule — only for SCHEDULED */}
          {post.status === "SCHEDULED" && (
            <Button
              variant="outline"
              onClick={handleCancelSchedule}
              disabled={updatePost.isPending}
            >
              <Ban className="mr-2 h-4 w-4" />
              Cancel Schedule
            </Button>
          )}

          {/* Publish Now — for DRAFT (immediate); Publish All — for SCHEDULED (re-queue immediately) */}
          {(post.status === "DRAFT" || post.status === "SCHEDULED") && (
            <Button
              onClick={handlePublishAll}
              disabled={publishNow.isPending || post.targets.length === 0}
              title={post.targets.length === 0 ? "Add at least one channel before publishing" : undefined}
            >
              {publishNow.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {post.status === "DRAFT" ? "Publish Now" : "Publish All Channels"}
            </Button>
          )}

          {/* Submit for review — for DRAFT */}
          {post.status === "DRAFT" && (
            <Button variant="outline" onClick={() => setReviewerOpen((v) => !v)}>
              Submit for review
            </Button>
          )}

          {/* Retry All Failed — for FAILED */}
          {post.status === "FAILED" && (
            <Button onClick={handlePublishAll} disabled={publishNow.isPending}>
              {publishNow.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              Retry All Failed
            </Button>
          )}

          {/* View on platform links — for PUBLISHED */}
          {post.status === "PUBLISHED" &&
            post.targets
              .filter((t: any) => t.publishedUrl)
              .map((target: any) => (
                <Button key={target.id} variant="outline" asChild>
                  <a href={target.publishedUrl!} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    View on {target.channel.platform.charAt(0) + target.channel.platform.slice(1).toLowerCase()}
                  </a>
                </Button>
              ))}
        </div>
      </div>

      {/* Reviewer picker panel — shown when Submit for review is toggled on a DRAFT post */}
      {reviewerOpen && post.status === "DRAFT" && (
        <div className="mt-3 rounded-lg border p-3 space-y-2 pb-8">
          <Label>Choose reviewers</Label>
          <div className="flex flex-col gap-1">
            {(teamMembers ?? []).map((m: any) => {
              const uid = m.user.id as string;
              const checked = reviewerIds.includes(uid);
              return (
                <label key={uid} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setReviewerIds((ids) =>
                        checked ? ids.filter((x) => x !== uid) : [...ids, uid]
                      )
                    }
                  />
                  {m.user.name ?? m.user.email}
                </label>
              );
            })}
          </div>
          <Button
            size="sm"
            disabled={reviewerIds.length === 0 || submitForReview.isPending}
            onClick={() => submitForReview.mutate({ postId, reviewerIds })}
          >
            {submitForReview.isPending ? "Submitting…" : "Send for review"}
          </Button>
        </div>
      )}
    </div>
  );
}
