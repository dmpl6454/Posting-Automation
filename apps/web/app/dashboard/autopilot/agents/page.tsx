"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
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
import { Plus, Trash2, Pencil, Bot, Loader2 } from "lucide-react";

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

export default function AutopilotAgentsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);

  const utils = trpc.useUtils();
  const { data: agents, isLoading } = trpc.agent.list.useQuery();
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
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {(agents as any[])?.length ?? 0} agent{((agents as any[])?.length ?? 0) !== 1 ? "s" : ""}
        </span>
        <Button className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          New Agent
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-24 w-full" /></CardContent></Card>
          ))}
        </div>
      ) : (agents as any[])?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Bot className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No agents yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create an agent to automate content generation.
          </p>
          <Button className="mt-4 gap-2" onClick={openCreate}>
            <Plus className="h-4 w-4" /> New Agent
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(agents as any[])?.map((agent: any) => (
            <Card key={agent.id}>
              <CardHeader className="flex flex-row items-start justify-between pb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <CardTitle className="truncate text-base">{agent.name}</CardTitle>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(agent)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate({ id: agent.id })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline" className="text-xs">{agent.niche || "No niche"}</Badge>
                  <Badge variant="secondary" className="text-xs">{agent.tone}</Badge>
                  <Badge variant="secondary" className="text-xs">{agent.aiProvider}</Badge>
                </div>
                {agent.topics?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {agent.topics.slice(0, 3).map((t: string) => (
                      <span key={t} className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{t}</span>
                    ))}
                    {agent.topics.length > 3 && (
                      <span className="text-[10px] text-muted-foreground">+{agent.topics.length - 3} more</span>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{agent.postsPerDay} posts/day · {agent.frequency}</span>
                  <span>{agent._count?.runs ?? 0} runs</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Active</span>
                  <Switch
                    checked={agent.isActive}
                    onCheckedChange={(v) => toggleMutation.mutate({ id: agent.id, isActive: v })}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
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
                  {allChannels.map((ch: any) => (
                    <label key={ch.id} className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-muted">
                      <input type="checkbox" className="h-4 w-4"
                        checked={form.channelIds.includes(ch.id)}
                        onChange={() => toggleChannel(ch.id)} />
                      <span className="text-sm">{ch.name} <span className="text-xs text-muted-foreground">({ch.platform})</span></span>
                    </label>
                  ))}
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
    </div>
  );
}
