"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import Link from "next/link";
import {
  Plus,
  Trash2,
  Users,
  Loader2,
  UserPlus,
  X,
} from "lucide-react";

/**
 * Design: each group card takes one hue from the palette's group ramp, cycling
 * by position — the same ramp the Agents, Channels, RSS and Short Links cards
 * use, so the workspace reads as one system.
 */
const GROUP_ACCENTS = [
  "#C9A356",
  "#8a9a7e",
  "#a17a5c",
  "#6b7d9e",
  "#b85c5c",
  "#7e8a9a",
  "#9a8a5c",
  "#5c8a7e",
] as const;

export default function AccountGroupsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [addAgentsDialogOpen, setAddAgentsDialogOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [form, setForm] = useState({
    name: "",
    topics: "",
    postsPerDay: 3,
    skipReviewGate: false,
  });

  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.accountGroup.list.useQuery();
  const { data: agentsData } = trpc.agent.list.useQuery();

  const createMutation = trpc.accountGroup.create.useMutation({
    onSuccess: () => {
      utils.accountGroup.list.invalidate();
      setDialogOpen(false);
      setForm({ name: "", topics: "", postsPerDay: 3, skipReviewGate: false });
    },
    onError: (error) => {
      console.error("Create group error:", error);
      alert(`Failed to create group: ${error.message}`);
    },
  });

  const deleteMutation = trpc.accountGroup.delete.useMutation({
    onSuccess: () => {
      utils.accountGroup.list.invalidate();
    },
  });

  const addAgentsMutation = trpc.accountGroup.addAgents.useMutation({
    onSuccess: () => {
      utils.accountGroup.list.invalidate();
      setAddAgentsDialogOpen(false);
      setSelectedAgentIds([]);
      setSelectedGroupId(null);
    },
    onError: (error) => {
      alert(`Failed to add agents: ${error.message}`);
    },
  });

  const removeAgentMutation = trpc.accountGroup.removeAgent.useMutation({
    onSuccess: () => {
      utils.accountGroup.list.invalidate();
    },
    onError: (error) => {
      alert(`Failed to remove agent: ${error.message}`);
    },
  });

  const groups = (data as any[]) ?? [];
  const agents = (agentsData as any[]) ?? [];

  // Agents not assigned to the currently selected group
  const getAvailableAgents = (groupId: string | null) => {
    if (!groupId) return agents.filter((a: any) => !a.accountGroupId);
    const group = groups.find((g: any) => g.id === groupId);
    const alreadyInGroup = new Set((group?.agents ?? []).map((a: any) => a.id));
    return agents.filter((a: any) => !alreadyInGroup.has(a.id));
  };

  const unassignedAgents = getAvailableAgents(selectedGroupId);

  const handleCreate = () => {
    createMutation.mutate({
      name: form.name,
      topics: form.topics
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      postsPerDay: form.postsPerDay,
      skipReviewGate: form.skipReviewGate,
    } as any);
  };

  const handleAddAgents = () => {
    if (!selectedGroupId || selectedAgentIds.length === 0) return;
    addAgentsMutation.mutate({
      groupId: selectedGroupId,
      agentIds: selectedAgentIds,
    } as any);
  };

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12.5px] leading-none text-muted-foreground">
          {groups.length} group{groups.length !== 1 ? "s" : ""}
        </span>
        <Button
          className="pa-cta-gold h-[34px] gap-[7px] rounded-[9px] px-3.5 text-[12.5px] font-semibold"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="h-[13px] w-[13px]" />
          New Group
        </Button>
      </div>

      {/* Loading */}
      {isLoading ? (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[200px] w-full rounded-[14px]" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Users className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No account groups</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a group to organize agents and configure autopilot settings.
          </p>
        </div>
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((group: any, idx: number) => {
            const accent = GROUP_ACCENTS[idx % GROUP_ACCENTS.length]!;
            return (
              <div
                key={group.id}
                className="rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-[9px]">
                    <div
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border"
                      style={{ background: `${accent}22`, borderColor: `${accent}55` }}
                    >
                      <Users className="h-[13px] w-[13px]" style={{ color: accent }} />
                    </div>
                    <p className="truncate text-[13.5px] font-semibold leading-[1.3]">
                      {group.name}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 rounded-[6px] text-muted-foreground hover:bg-hover hover:text-foreground"
                      aria-label={`Add agents to ${group.name}`}
                      onClick={() => {
                        setSelectedGroupId(group.id);
                        setSelectedAgentIds([]);
                        setAddAgentsDialogOpen(true);
                      }}
                    >
                      <UserPlus className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 rounded-[6px] text-faint hover:bg-hover hover:text-[#c96b56]"
                      aria-label={`Delete ${group.name}`}
                      disabled={deleteMutation.isPending}
                      onClick={() => { if (confirm(`Delete group "${group.name}"? This cannot be undone.`)) deleteMutation.mutate({ id: group.id } as any); }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>

                {/* Agent chips */}
                <div className="mt-3 flex flex-wrap gap-[5px]">
                  {(group.agents?.length ?? 0) === 0 ? (
                    <span className="text-[10px] leading-[1.6] text-faint">No agents yet</span>
                  ) : (
                    group.agents.map((agent: any) => (
                      <span
                        key={agent.id}
                        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-border2 px-2 py-[1.5px] text-[10px] font-medium leading-[1.6] text-muted-foreground"
                      >
                        {agent.name}
                        <button
                          className="ml-0.5 hover:text-[#c96b56] disabled:opacity-50"
                          aria-label={`Remove ${agent.name}`}
                          disabled={removeAgentMutation.isPending && (removeAgentMutation.variables as any)?.agentId === agent.id}
                          onClick={() =>
                            removeAgentMutation.mutate({ agentId: agent.id } as any)
                          }
                        >
                          {removeAgentMutation.isPending && (removeAgentMutation.variables as any)?.agentId === agent.id
                            ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            : <X className="h-2.5 w-2.5" />}
                        </button>
                      </span>
                    ))
                  )}
                </div>

                {group.topics?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-[5px]">
                    {group.topics.map((topic: string, i: number) => (
                      <span
                        key={i}
                        className="rounded-[4px] bg-tile px-1.5 py-[1.5px] text-[9.5px] leading-[1.6] text-faint"
                      >
                        {topic}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-3 flex items-center justify-between text-[11px] leading-none text-faint">
                  <span>{group.postsPerDay ?? 3} posts/day</span>
                  <span>Threshold: {group.sensitivityThreshold ?? "MEDIUM"}</span>
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                  <span className="text-[11.5px] leading-none text-muted-foreground">
                    Auto-approve
                  </span>
                  <span
                    className={`rounded-full px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] ${
                      group.skipReviewGate
                        ? "border border-[hsl(var(--accent-border))] bg-gold/[0.12] text-gold"
                        : "bg-tile text-muted-foreground"
                    }`}
                  >
                    {group.skipReviewGate ? "On" : "Off"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Account Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="group-name">Name</Label>
              <Input
                id="group-name"
                placeholder="e.g. Tech Influencers"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-topics">Topics (comma-separated)</Label>
              <Input
                id="group-topics"
                placeholder="e.g. AI, SaaS, Startups"
                value={form.topics}
                onChange={(e) =>
                  setForm((f) => ({ ...f, topics: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-ppd">Posts per Day</Label>
              <Input
                id="group-ppd"
                type="number"
                min={1}
                max={50}
                value={form.postsPerDay}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    postsPerDay: parseInt(e.target.value) || 1,
                  }))
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="group-skip">Skip review gate (auto-approve)</Label>
              <Switch
                id="group-skip"
                checked={form.skipReviewGate}
                onCheckedChange={(checked) =>
                  setForm((f) => ({ ...f, skipReviewGate: checked }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!form.name || createMutation.isPending}
            >
              {createMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Create Group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Agents Dialog */}
      <Dialog open={addAgentsDialogOpen} onOpenChange={setAddAgentsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Agents to Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-[400px] overflow-y-auto">
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No agents created yet.{" "}
                <Link href="/dashboard/autopilot/agents" className="underline font-medium">
                  Go to Autopilot → Agents
                </Link>{" "}
                to create one first.
              </p>
            ) : unassignedAgents.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                All agents are already in this group.
              </p>
            ) : (
              unassignedAgents.map((agent: any) => (
                <label
                  key={agent.id}
                  className="flex items-center gap-3 p-2 rounded-md hover:bg-muted cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300"
                    checked={selectedAgentIds.includes(agent.id)}
                    onChange={() => toggleAgent(agent.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{agent.name}</p>
                    {agent.platform && (
                      <p className="text-xs text-muted-foreground">{agent.platform}</p>
                    )}
                  </div>
                </label>
              ))
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddAgentsDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddAgents}
              disabled={selectedAgentIds.length === 0 || addAgentsMutation.isPending}
            >
              {addAgentsMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Add {selectedAgentIds.length > 0 ? `(${selectedAgentIds.length})` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
