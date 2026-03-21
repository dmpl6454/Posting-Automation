"use client";

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

  const { data: post, isLoading, refetch } = trpc.post.getById.useQuery({ id: postId });

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

  const updatePost = trpc.post.update.useMutation({
    onSuccess: () => {
      toast({ title: "Post updated", description: "Your changes have been saved." });
      setHasChanges(false);
      refetch();
    },
    onError: (err) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const deletePost = trpc.post.delete.useMutation({
    onSuccess: () => {
      toast({ title: "Post deleted", description: "The post has been removed." });
      router.push("/dashboard/posts");
    },
    onError: (err) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const publishNow = trpc.post.publishNow.useMutation({
    onSuccess: () => {
      toast({ title: "Publishing started", description: "Publishing to selected channels." });
      refetch();
    },
    onError: (err) => {
      toast({ title: "Publish failed", description: err.message, variant: "destructive" });
    },
  });

  const [retryingTargetId, setRetryingTargetId] = useState<string | null>(null);

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

  const handlePublishNow = () => {
    const failedCount = post?.targets.filter((t: any) => t.status === "FAILED").length ?? 0;
    const msg = failedCount > 0
      ? `Retry publishing to ${failedCount} failed channel${failedCount !== 1 ? "s" : ""}?`
      : "Publish this post now to selected channels?";
    if (confirm(msg)) {
      publishNow.mutate({ id: postId });
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
                  className="flex items-center justify-between rounded-lg border p-3"
                >
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
                    {target.status === "FAILED" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => handleRetryTarget(target.id)}
                        disabled={retryingTargetId === target.id}
                      >
                        {retryingTargetId === target.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        <span className="ml-1">Retry</span>
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
                  {attachment.media.thumbnailUrl ? (
                    <img
                      src={attachment.media.thumbnailUrl}
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
                <Input
                  id="schedule-date"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => handleScheduleChange(e.target.value)}
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

          {/* Publish Now — for DRAFT, SCHEDULED */}
          {(post.status === "DRAFT" || post.status === "SCHEDULED") && (
            <Button onClick={handlePublishNow} disabled={publishNow.isPending}>
              {publishNow.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Publish Now
            </Button>
          )}

          {/* Retry — for FAILED */}
          {post.status === "FAILED" && (
            <Button onClick={handlePublishNow} disabled={publishNow.isPending}>
              {publishNow.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              Retry Publish
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
    </div>
  );
}
