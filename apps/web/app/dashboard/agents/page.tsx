"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import { Bot, Plus, Clock, Zap, Settings, Calendar } from "lucide-react";

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

function providerLabel(provider: string): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Claude";
    case "gemini":
      return "Gemini";
    default:
      return provider;
  }
}

export default function AgentsPage() {
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const { data: agents, isLoading } = trpc.agent.list.useQuery();

  const toggle = trpc.agent.toggle.useMutation({
    onSuccess: () => {
      utils.agent.list.invalidate();
    },
  });

  const runNow = trpc.agent.runNow.useMutation({
    onSuccess: () => {
      toast({ title: "Agent triggered", description: "The agent run has been queued." });
      utils.agent.list.invalidate();
    },
    onError: (err) => {
      toast({
        title: "Run failed",
        description: err.message || "Could not trigger the agent.",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-10 w-36" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-6 space-y-4">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-8 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AI Agents</h1>
          <p className="text-muted-foreground">
            Automate content creation with AI-powered agents
          </p>
        </div>
        <Button asChild className="gap-2">
          <Link href="/dashboard/agents/new">
            <Plus className="h-4 w-4" />
            Create Agent
          </Link>
        </Button>
      </div>

      {/* Agent Grid */}
      {!agents || agents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <Bot className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">No AI agents yet</h3>
            <p className="text-muted-foreground mt-1 mb-4 max-w-sm">
              Create your first AI agent to automatically generate and schedule
              social media content.
            </p>
            <Button asChild className="gap-2">
              <Link href="/dashboard/agents/new">
                <Plus className="h-4 w-4" />
                Create Agent
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent: any) => (
            <Card key={agent.id} className="relative overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Bot className="h-4 w-4 text-purple-500" />
                      {agent.name}
                    </CardTitle>
                    <div className="flex items-center gap-2">
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
                      <Badge variant="outline">{providerLabel(agent.aiProvider)}</Badge>
                    </div>
                  </div>
                  <Switch
                    checked={agent.isActive}
                    onCheckedChange={() =>
                      toggle.mutate({ id: agent.id, isActive: !agent.isActive })
                    }
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground line-clamp-1">
                  {agent.niche || "No niche specified"}
                </p>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-muted/50 p-2">
                    <Calendar className="h-3.5 w-3.5 mx-auto text-muted-foreground mb-1" />
                    <p className="text-xs font-medium capitalize">
                      {agent.cronExpression === "0 9 * * *"
                        ? "Daily"
                        : agent.cronExpression === "0 9 * * 1-5"
                        ? "Weekdays"
                        : agent.cronExpression === "0 9 * * 1"
                        ? "Weekly"
                        : "Custom"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-2">
                    <Zap className="h-3.5 w-3.5 mx-auto text-muted-foreground mb-1" />
                    <p className="text-xs font-medium">
                      {agent.postsPerDay ?? 1}/day
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-2">
                    <Bot className="h-3.5 w-3.5 mx-auto text-muted-foreground mb-1" />
                    <p className="text-xs font-medium">
                      {agent._count?.runs ?? 0} runs
                    </p>
                  </div>
                </div>

                {/* Last run */}
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  Last run: {formatRelativeTime(agent.lastRunAt)}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-1.5"
                    onClick={() => runNow.mutate({ id: agent.id })}
                    disabled={runNow.isPending}
                  >
                    <Zap className="h-3.5 w-3.5" />
                    Run Now
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1 gap-1.5" asChild>
                    <Link href={`/dashboard/agents/${agent.id}`}>
                      <Settings className="h-3.5 w-3.5" />
                      Details
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
