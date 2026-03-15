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
import {
  Plus,
  Trash2,
  Users,
  Loader2,
} from "lucide-react";

export default function AccountGroupsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    topics: "",
    postsPerDay: 3,
    skipReviewGate: false,
  });

  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.accountGroup.list.useQuery();

  const createMutation = trpc.accountGroup.create.useMutation({
    onSuccess: () => {
      utils.accountGroup.list.invalidate();
      setDialogOpen(false);
      setForm({ name: "", topics: "", postsPerDay: 3, skipReviewGate: false });
    },
  });

  const deleteMutation = trpc.accountGroup.delete.useMutation({
    onSuccess: () => {
      utils.accountGroup.list.invalidate();
    },
  });

  const groups = (data as any[]) ?? [];

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

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {groups.length} group{groups.length !== 1 ? "s" : ""}
        </span>
        <Button className="gap-2" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          New Group
        </Button>
      </div>

      {/* Loading */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((group: any) => (
            <Card key={group.id}>
              <CardHeader className="flex flex-row items-start justify-between pb-2">
                <CardTitle className="text-base">{group.name}</CardTitle>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate({ id: group.id } as any)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  {group.agents?.length ?? 0} agent
                  {(group.agents?.length ?? 0) !== 1 ? "s" : ""}
                </div>

                {group.topics?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {group.topics.map((topic: string, idx: number) => (
                      <Badge
                        key={idx}
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0"
                      >
                        {topic}
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{group.postsPerDay ?? 3} posts/day</span>
                  <span>
                    Threshold: {group.sensitivityThreshold ?? "MEDIUM"}
                  </span>
                </div>

                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Auto-approve</span>
                  <Badge
                    variant={group.skipReviewGate ? "default" : "outline"}
                    className="text-[10px]"
                  >
                    {group.skipReviewGate ? "On" : "Off"}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
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
    </div>
  );
}
