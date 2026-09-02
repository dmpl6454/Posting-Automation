"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
import { Plus, Trash2, Pencil, Bot, Loader2, Play, Info } from "lucide-react";

/**
 * Design: each agent card takes one hue from the palette's group ramp, cycling
 * by position — the same ramp the Channels, RSS and Short Links cards use, so
 * a workspace reads as one system rather than eight unrelated colour schemes.
 */
const AGENT_ACCENTS = [
  "#C9A356",
  "#8a9a7e",
  "#a17a5c",
  "#6b7d9e",
  "#b85c5c",
  "#7e8a9a",
  "#9a8a5c",
  "#5c8a7e",
] as const;

const TONES = ["professional", "casual", "humorous", "formal", "inspiring"] as const;
const FREQUENCIES = ["daily", "weekdays", "weekly", "custom"] as const;
const AI_PROVIDERS = ["anthropic", "openai", "gemini"] as const;

const defaultForm = {
  name: "",
  niche: "",
  topics: "",
  tone: "professional" as typeof TONES[number],
  language: "english",
  aiProvider: "anthropic" as typeof AI_PROVIDERS[number],
  frequency: "daily" as typeof FREQUENCIES[number],
  postsPerDay: 3,
  cronExpression: "0 9 * * *",
  channelIds: [] as string[],
  customPrompt: "",
};

function AutopilotAgentsPageInner() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);

  const utils = trpc.useUtils();
  const { data: agents, isLoading } = trpc.agent.list.useQuery();
  const [pendingDelete, setPendingDelete] = useState<NonNullable<typeof agents>[number] | null>(null);
  const { data: channels } = trpc.channel.list.useQuery();

  const createMutation = trpc.agent.create.useMutation({
    onSuccess: () => { utils.agent.list.invalidate(); closeDialog(); },
    onError: (e) => alert(e.message),
  });

  const updateMutation = trpc.agent.update.useMutation({
    onSuccess: () => { utils.agent.list.invalidate(); closeDialog(); },
    onError: (e) => alert(e.message),
  });

  const toggleMutation = trpc.agent.toggle.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });

  const deleteMutation = trpc.agent.delete.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });

  const runNowMutation = trpc.agent.runNow.useMutation({
    onSuccess: () => {
      alert("Agent queued! It will generate drafts in a minute — review and approve them in Autopilot → Review Queue (they publish after approval, unless this agent's account group skips review).");
      utils.agent.list.invalidate();
      // The AgentRun row is created asynchronously by the worker, so also
      // refetch shortly after to catch the incremented count.
      setTimeout(() => utils.agent.list.invalidate(), 3000);
    },
    onError: (e) => alert(e.message),
  });

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingId(null);
    setForm(defaultForm);
  };

  const openCreate = () => {
    setForm(defaultForm);
    setEditingId(null);
    setDialogOpen(true);
  };

  const openEdit = (agent: any) => {
    setForm({
      name: agent.name,
      niche: agent.niche,
      topics: agent.topics.join(", "),
      tone: agent.tone,
      language: agent.language,
      aiProvider: agent.aiProvider,
      frequency: agent.frequency,
      postsPerDay: agent.postsPerDay,
      cronExpression: agent.cronExpression,
      channelIds: agent.channelIds,
      customPrompt: agent.customPrompt ?? "",
    });
    setEditingId(agent.id);
    setDialogOpen(true);
  };

  const handleSave = () => {
    const payload = {
      name: form.name,
      niche: form.niche,
      topics: form.topics.split(",").map((t) => t.trim()).filter(Boolean),
      tone: form.tone,
      language: form.language,
      aiProvider: form.aiProvider,
      frequency: form.frequency,
      postsPerDay: form.postsPerDay,
      cronExpression: form.cronExpression,
      channelIds: form.channelIds,
      customPrompt: form.customPrompt || undefined,
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const allChannels = (channels as any[]) ?? [];

  const toggleChannel = (id: string) => {
    setForm((f) => ({
      ...f,
      channelIds: f.channelIds.includes(id)
        ? f.channelIds.filter((c) => c !== id)
        : [...f.channelIds, id],
    }));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12.5px] leading-none text-muted-foreground">
          {(agents as any[])?.length ?? 0} agent{((agents as any[])?.length ?? 0) !== 1 ? "s" : ""}
        </span>
        <Button
          className="pa-cta-gold h-[34px] gap-[7px] rounded-[9px] px-3.5 text-[12.5px] font-semibold"
          onClick={openCreate}
        >
          <Plus className="h-[13px] w-[13px]" />
          New Agent
        </Button>
      </div>

      {/* Design: a quiet surface-1 note rather than the Alert component. */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
        <Info className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
        <p className="text-[12px] leading-[1.6] text-muted-foreground">
          <b className="text-foreground">How Agents work:</b> reusable templates that drive
          Autopilot runs, each with a persona, niche, topics, tone, and posting schedule.
          Toggle Active to include an agent in the next run, or Run Now to generate immediately.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[210px] w-full rounded-[14px]" />
          ))}
        </div>
      ) : (agents as any[])?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Bot className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No agents yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create an agent to automate content generation.
          </p>
          <Button
            className="pa-cta-gold mt-4 h-[34px] gap-[7px] rounded-[9px] px-3.5 text-[12.5px] font-semibold"
            onClick={openCreate}
          >
            <Plus className="h-[13px] w-[13px]" /> New Agent
          </Button>
        </div>
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {(agents as any[])?.map((agent: any, idx: number) => {
            const accent = AGENT_ACCENTS[idx % AGENT_ACCENTS.length]!;
            return (
              <div
                key={agent.id}
                className="rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)] transition-transform hover:-translate-y-0.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-[9px]">
                    <div
                      className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border"
                      style={{ background: `${accent}22`, borderColor: `${accent}55` }}
                    >
                      <Bot className="h-3.5 w-3.5" style={{ color: accent }} />
                    </div>
                    <p className="truncate text-[13.5px] font-semibold leading-[1.3]">
                      {agent.name}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 rounded-[6px] text-muted-foreground hover:bg-hover hover:text-foreground"
                      title="Run Now"
                      disabled={runNowMutation.isPending}
                      onClick={() => runNowMutation.mutate({ id: agent.id })}
                    >
                      <Play className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 rounded-[6px] text-muted-foreground hover:bg-hover hover:text-foreground"
                      aria-label={`Edit ${agent.name}`}
                      onClick={() => openEdit(agent)}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 rounded-[6px] text-faint hover:bg-hover hover:text-[#c96b56]"
                      aria-label={`Delete ${agent.name}`}
                      disabled={deleteMutation.isPending}
                      onClick={() => setPendingDelete(agent)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-[5px]">
                  <span className="rounded-[5px] border border-border2 px-2 py-0.5 text-[10px] font-medium leading-[1.6] text-muted-foreground">
                    {agent.niche || "No niche"}
                  </span>
                  <span className="rounded-[5px] bg-tile px-2 py-0.5 text-[10px] font-medium leading-[1.6] text-muted-foreground">
                    {agent.tone}
                  </span>
                  <span className="rounded-[5px] bg-tile px-2 py-0.5 text-[10px] font-medium leading-[1.6] text-muted-foreground">
                    {agent.aiProvider}
                  </span>
                </div>

                {agent.topics?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-[5px]">
                    {agent.topics.slice(0, 3).map((t: string) => (
                      <span
                        key={t}
                        className="rounded-[4px] bg-tile px-1.5 py-[1.5px] text-[9.5px] leading-[1.6] text-faint"
                      >
                        {t}
                      </span>
                    ))}
                    {agent.topics.length > 3 && (
                      <span className="text-[9.5px] leading-[1.6] text-faint">
                        +{agent.topics.length - 3} more
                      </span>
                    )}
                  </div>
                )}

                <div className="mt-3 flex items-center justify-between text-[11px] leading-none text-faint">
                  <span>{agent.postsPerDay} posts/day · {agent.frequency}</span>
                  <span>{agent._count?.runs ?? 0} runs</span>
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                  <span className="text-[11.5px] leading-none text-muted-foreground">Active</span>
                  <Switch
                    checked={agent.isActive}
                    disabled={toggleMutation.isPending && toggleMutation.variables?.id === agent.id}
                    onCheckedChange={(v) => toggleMutation.mutate({ id: agent.id, isActive: v })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) closeDialog(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Agent" : "New Agent"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input placeholder="e.g. Bollywood News Bot" value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>

            <div className="space-y-1.5">
              <Label>Niche</Label>
              <Input placeholder="e.g. Bollywood, Tech, Cricket" value={form.niche}
                onChange={(e) => setForm((f) => ({ ...f, niche: e.target.value }))} />
            </div>

            <div className="space-y-1.5">
              <Label>Topics <span className="text-muted-foreground text-xs">(comma-separated)</span></Label>
              <Input placeholder="e.g. Celebrity News, Box Office, Awards" value={form.topics}
                onChange={(e) => setForm((f) => ({ ...f, topics: e.target.value }))} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Tone</Label>
                <Select value={form.tone} onValueChange={(v) => setForm((f) => ({ ...f, tone: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Language</Label>
                <Input placeholder="english" value={form.language}
                  onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>AI Provider</Label>
                <Select value={form.aiProvider} onValueChange={(v) => setForm((f) => ({ ...f, aiProvider: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AI_PROVIDERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Frequency</Label>
                <Select value={form.frequency} onValueChange={(v) => setForm((f) => ({ ...f, frequency: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Posts per Day</Label>
              <Input type="number" min={1} max={10} value={form.postsPerDay}
                onChange={(e) => setForm((f) => ({ ...f, postsPerDay: parseInt(e.target.value) || 1 }))} />
            </div>

            <div className="space-y-1.5">
              <Label>Channels <span className="text-xs text-muted-foreground">(select at least one)</span></Label>
              {allChannels.length === 0 ? (
                <p className="text-sm text-muted-foreground">No channels connected. Go to Channels to connect first.</p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto border rounded-md p-2">
                  {allChannels.map((ch: any) => {
                    const meta = (ch.metadata as Record<string, any>) ?? {};
                    const templateType = meta.template_type || null;
                    return (
                    <label key={ch.id} className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-muted">
                      <input type="checkbox" className="h-4 w-4 shrink-0"
                        checked={form.channelIds.includes(ch.id)}
                        onChange={() => toggleChannel(ch.id)} />
                      {ch.avatar ? (
                        <img src={ch.avatar} alt="" className="h-6 w-6 rounded-full shrink-0 object-cover" />
                      ) : (
                        <div className="h-6 w-6 rounded-full shrink-0 bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">
                          {ch.name?.[0]?.toUpperCase() || "?"}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <span className="text-sm truncate block">{ch.name} <span className="text-xs text-muted-foreground">({ch.platform})</span></span>
                      </div>
                      {templateType && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">
                          {templateType.replace(/_/g, " ")}
                        </span>
                      )}
                    </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Custom Prompt <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Textarea placeholder="Leave blank to use auto-generated prompt based on niche and topics..."
                rows={3} value={form.customPrompt}
                onChange={(e) => setForm((f) => ({ ...f, customPrompt: e.target.value }))} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button onClick={handleSave}
              disabled={!form.name || !form.niche || form.channelIds.length === 0 || isPending}>
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {editingId ? "Save Changes" : "Create Agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        title="Delete agent"
        description={`Delete agent "${pendingDelete?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (pendingDelete) {
            deleteMutation.mutate({ id: pendingDelete.id });
            setPendingDelete(null);
          }
        }}
      />
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function AutopilotAgentsPage() {
  return (
    <RequireAppAdmin>
      <AutopilotAgentsPageInner />
    </RequireAppAdmin>
  );
}
