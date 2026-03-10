"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import { Webhook, Plus, Trash2, Copy } from "lucide-react";

const EVENTS = [
  "post.published",
  "post.failed",
  "post.scheduled",
  "channel.connected",
  "channel.disconnected",
];

export default function WebhooksPage() {
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);

  const { data: webhooks, isLoading, refetch } = trpc.webhook.list.useQuery();
  const create = trpc.webhook.create.useMutation({
    onSuccess: () => {
      setUrl("");
      setSelectedEvents([]);
      refetch();
      toast({ title: "Webhook created" });
    },
    onError: (err) => {
      toast({ title: "Failed to create webhook", description: err.message, variant: "destructive" });
    },
  });
  const remove = trpc.webhook.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Webhook deleted" });
    },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Webhooks</h1>
        <p className="text-muted-foreground">Get notified when events happen in your account</p>
      </div>

      {/* Add Webhook */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Add Webhook</CardTitle>
          <CardDescription>We&apos;ll send a POST request to your URL for each selected event</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Endpoint URL</Label>
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-app.com/webhook"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Events</Label>
            <div className="flex flex-wrap gap-2">
              {EVENTS.map((event) => {
                const isSelected = selectedEvents.includes(event);
                return (
                  <button
                    key={event}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedEvents(selectedEvents.filter((e) => e !== event));
                      } else {
                        setSelectedEvents([...selectedEvents, event]);
                      }
                    }}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                      isSelected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted hover:border-muted-foreground/50 hover:bg-muted/50"
                    }`}
                  >
                    {event}
                  </button>
                );
              })}
            </div>
          </div>
          <Button
            onClick={() => create.mutate({ url, events: selectedEvents })}
            disabled={!url || selectedEvents.length === 0 || create.isPending}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Webhook
          </Button>
        </CardContent>
      </Card>

      {/* Existing Webhooks */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Active Webhooks</CardTitle>
          <CardDescription>{webhooks?.length || 0} webhook{webhooks?.length !== 1 ? "s" : ""} configured</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {[1, 2].map((i) => <Skeleton key={i} className="h-14" />)}
            </div>
          ) : webhooks?.length === 0 ? (
            <div className="flex flex-col items-center py-12">
              <Webhook className="h-8 w-8 text-muted-foreground/30" />
              <p className="mt-2 text-sm text-muted-foreground">No webhooks configured</p>
            </div>
          ) : (
            <div className="divide-y">
              {webhooks?.map((wh: any) => (
                <div key={wh.id} className="flex items-center gap-4 px-6 py-4">
                  <Webhook className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium font-mono">{wh.url}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {wh.events.map((event: any) => (
                        <Badge key={event} variant="outline" className="text-[10px]">
                          {event}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => remove.mutate({ id: wh.id })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
