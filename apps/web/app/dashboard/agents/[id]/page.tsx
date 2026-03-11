"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useToast } from "~/hooks/use-toast";
import {
  Bot,
  Zap,
  Trash2,
  ArrowLeft,
  Clock,
  Calendar,
  MessageSquare,
  Target,
  Sparkles,
  Hash,
} from "lucide-react";
import { Switch } from "~/components/ui/switch";

function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return "Never";
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString();
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return "-";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function frequencyLabel(cron: string | null | undefined): string {
  switch (cron) {
    case "0 9 * * *":
      return "Daily at 9:00 AM";
    case "0 9 * * 1-5":
      return "Weekdays at 9:00 AM";
    case "0 9 * * 1":
      return "Weekly (Monday) at 9:00 AM";
    default:
      return cron || "Not set";
  }
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "openai":
      return "OpenAI (GPT-4)";
    case "anthropic":
      return "Anthropic (Claude)";
    case "gemini":
      return "Google (Gemini)";
    default:
      return provider;
  }
}

function statusBadge(status: string) {
  switch (status) {
    case "RUNNING":
      return <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">Running</Badge>;
    case "COMPLETED":
      return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Completed</Badge>;
    case "FAILED":
      return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">Failed</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const id = params.id as string;

  const { data: agent, isLoading, error } = trpc.agent.getById.useQuery({ id });

  const toggle = trpc.agent.toggle.useMutation({
    onSuccess: () => {
      utils.agent.getById.invalidate({ id });
    },
  });

  const runNow = trpc.agent.runNow.useMutation({
    onSuccess: () => {
      toast({ title: "Agent triggered", description: "The agent run has been queued." });
      utils.agent.getById.invalidate({ id });
    },
    onError: (err) => {
      toast({
        title: "Run failed",
        description: err.message || "Could not trigger the agent.",
        variant: "destructive",
      });
    },
  });

  const deleteAgent = trpc.agent.delete.useMutation({
    onSuccess: () => {
      toast({ title: "Agent deleted" });
      router.push("/dashboard/agents");
    },
    onError: (err) => {
      toast({
        title: "Delete failed",
        description: err.message || "Could not delete the agent.",
        variant: "destructive",
      });
    },
  });

  const handleDelete = () => {
    if (window.confirm("Are you sure you want to delete this agent? This action cannot be undone.")) {
      deleteAgent.mutate({ id });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-48" />
        </div>
        <Card>
          <CardContent className="p-6 space-y-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" className="gap-2" asChild>
          <Link href="/dashboard/agents">
            <ArrowLeft className="h-4 w-4" />
            Back to Agents
          </Link>
        </Button>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <h3 className="text-lg font-semibold">Agent not found</h3>
            <p className="text-muted-foreground mt-1">
              This agent may have been deleted or you don't have access.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Button variant="ghost" size="sm" className="gap-2" asChild>
        <Link href="/dashboard/agents">
          <ArrowLeft className="h-4 w-4" />
          Back to Agents
        </Link>
      </Button>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-purple-100 p-2 dark:bg-purple-900/30">
            <Bot className="h-5 w-5 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{agent.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge
                variant={agent.isActive ? "default" : "secondary"}
                className={
                  agent.isActive
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : ""
                }
              >
                {agent.isActive ? "Active" : "Paused"}
              </Badge>
              <span className="text-sm text-muted-foreground">
                Last run: {formatRelativeTime(agent.lastRunAt)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            checked={agent.isActive}
            onCheckedChange={() =>
              toggle.mutate({ id: agent.id, isActive: !agent.isActive })
            }
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => runNow.mutate({ id: agent.id })}
            disabled={runNow.isPending}
          >
            <Zap className="h-3.5 w-3.5" />
            Run Now
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="gap-1.5"
            onClick={handleDelete}
            disabled={deleteAgent.isPending}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        </div>
      </div>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
          <CardDescription>Agent settings and content preferences</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" />
                AI Provider
              </div>
              <p className="text-sm font-medium">{providerLabel(agent.aiProvider)}</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Target className="h-3.5 w-3.5" />
                Niche
              </div>
              <p className="text-sm font-medium">{agent.niche || "Not specified"}</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Hash className="h-3.5 w-3.5" />
                Topics
              </div>
              <div className="flex flex-wrap gap-1">
                {agent.topics && agent.topics.length > 0 ? (
                  agent.topics.map((topic: string) => (
                    <Badge key={topic} variant="secondary" className="text-xs">
                      {topic}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">None</span>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" />
                Tone
              </div>
              <p className="text-sm font-medium capitalize">{agent.tone || "Professional"}</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-3.5 w-3.5" />
                Frequency
              </div>
              <p className="text-sm font-medium">{frequencyLabel(agent.cronExpression)}</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Zap className="h-3.5 w-3.5" />
                Posts Per Run
              </div>
              <p className="text-sm font-medium">{agent.postsPerDay ?? 1}</p>
            </div>
          </div>

          {agent.customPrompt && (
            <div className="mt-4 space-y-1">
              <p className="text-sm text-muted-foreground">Custom Prompt</p>
              <div className="rounded-lg bg-muted/50 p-3 text-sm">
                {agent.customPrompt}
              </div>
            </div>
          )}

          {agent.channels && agent.channels.length > 0 && (
            <div className="mt-4 space-y-1">
              <p className="text-sm text-muted-foreground">Target Channels</p>
              <div className="flex flex-wrap gap-1.5">
                {agent.channels.map((ch: any) => (
                  <Badge key={ch.id} variant="outline" className="text-xs">
                    {ch.name || ch.username} ({ch.platform?.charAt(0) + ch.platform?.slice(1).toLowerCase()})
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Run History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Run History
          </CardTitle>
          <CardDescription>Recent agent execution history</CardDescription>
        </CardHeader>
        <CardContent>
          {agent.runs && agent.runs.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Posts Created</TableHead>
                  <TableHead>Topic</TableHead>
                  <TableHead>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agent.runs.map((run: any) => (
                  <TableRow key={run.id}>
                    <TableCell className="text-sm">
                      {new Date(run.startedAt).toLocaleDateString()}{" "}
                      <span className="text-muted-foreground">
                        {new Date(run.startedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </TableCell>
                    <TableCell>{statusBadge(run.status)}</TableCell>
                    <TableCell className="text-sm">{run.postsCreated ?? 0}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                      {run.topicUsed || "-"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDuration(
                        run.completedAt && run.startedAt
                          ? Math.floor((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
                          : null
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Clock className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                No runs yet. Trigger a run or wait for the next scheduled execution.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
