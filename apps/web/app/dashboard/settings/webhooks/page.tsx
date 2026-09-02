"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { humanizeError } from "~/lib/errors";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import Link from "next/link";
import { Webhook, Plus, PlusCircle, Trash2, Eye } from "lucide-react";

const EVENTS = [
  "post.published",
  "post.failed",
  "post.scheduled",
  "channel.connected",
  "channel.disconnected",
];

/* Design tokens for this page. Local (not shared helpers) for the same reason
   the Settings page keeps its own: the shared `.pa-section-head` carries a
   trailing-link layout the Dashboard depends on. */
function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="text-[10.5px] font-semibold uppercase leading-none tracking-[0.12em] text-faint">
        {children}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

const CARD = "rounded-[14px] border border-border bg-card p-[22px]";
const CARD_HEAD = "flex items-center gap-2";
const CARD_TITLE = "text-[14.5px] font-semibold leading-[1.2]";
const FIELD_LABEL = "text-[11.5px] font-medium leading-none text-muted-foreground";
const FIELD_38 =
  "h-[38px] rounded-[8px] border-border2 bg-background px-3 text-[12.5px]";

function WebhooksPageInner() {
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
      toast({ title: "Failed to create webhook", description: humanizeError(err), variant: "destructive" });
    },
  });
  const remove = trpc.webhook.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Webhook deleted" });
    },
  });

  return (
    <div className="w-full">
      {/* Page header — eyebrow / display title / subtitle (design restyle) */}
      <div className="min-w-0">
        <span className="eyebrow">Webhooks</span>
        <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
          Know the moment it happens.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Get notified when events happen in your account
        </p>
      </div>

      <div className="mt-[26px] flex flex-col gap-7">
        {/* Configure */}
        <section>
          <SectionHead>Configure</SectionHead>
          <div className={CARD}>
            <div className={CARD_HEAD}>
              <PlusCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
              <h2 className={CARD_TITLE}>Add Webhook</h2>
            </div>
            <p className="ml-6 mt-[5px] text-[12px] leading-[1.5] text-muted-foreground">
              We&apos;ll send a POST request to your URL for each selected event
            </p>

            <div className="mt-4">
              <label className={FIELD_LABEL} htmlFor="webhook-url">
                Endpoint URL
              </label>
              <Input
                id="webhook-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-app.com/webhook"
                className={`mt-[7px] ${FIELD_38}`}
              />
            </div>

            <div className="mt-3.5">
              <span className={FIELD_LABEL}>Events</span>
              {/* Design puts the CTA on the same row as the chips, right-aligned. */}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap gap-2">
                  {EVENTS.map((event) => {
                    const isSelected = selectedEvents.includes(event);
                    return (
                      <button
                        key={event}
                        type="button"
                        onClick={() => {
                          if (isSelected) {
                            setSelectedEvents(selectedEvents.filter((e) => e !== event));
                          } else {
                            setSelectedEvents([...selectedEvents, event]);
                          }
                        }}
                        className={`rounded-[8px] border px-3 py-1.5 font-mono text-[11.5px] font-medium leading-none transition-colors ${
                          isSelected
                            ? "border-[hsl(var(--accent-border))] bg-gold/[0.12] text-gold"
                            : "border-border2 text-muted-foreground hover:bg-hover hover:text-foreground"
                        }`}
                      >
                        {event}
                      </button>
                    );
                  })}
                </div>
                <Button
                  className="pa-cta-gold h-9 shrink-0 gap-1.5 rounded-[8px] px-[15px] text-[12.5px] font-semibold"
                  onClick={() => create.mutate({ url, events: selectedEvents })}
                  disabled={!url || selectedEvents.length === 0 || create.isPending}
                >
                  <Plus className="h-[13px] w-[13px]" />
                  Add Webhook
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* Active */}
        <section>
          <SectionHead>Active</SectionHead>
          <div className="overflow-hidden rounded-[14px] border border-border bg-card">
            <div className="flex items-center justify-between gap-3 border-b border-border px-[22px] py-[18px]">
              <h2 className={CARD_TITLE}>Active Webhooks</h2>
              <span className="text-[11.5px] font-medium leading-none text-faint">
                {webhooks?.length || 0} configured
              </span>
            </div>
            {isLoading ? (
              <div className="space-y-3 p-[22px]">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-14 rounded-[10px]" />
                ))}
              </div>
            ) : webhooks?.length === 0 ? (
              <div className="flex flex-col items-center py-12">
                <Webhook className="h-8 w-8 text-tile" />
                <p className="mt-2.5 text-[12.5px] text-muted-foreground">
                  No webhooks configured
                </p>
              </div>
            ) : (
              webhooks?.map((wh: any) => (
                <div
                  key={wh.id}
                  className="flex items-center gap-3.5 border-b border-border px-[22px] py-4 last:border-b-0"
                >
                  <Webhook className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[12.5px] font-medium leading-[1.3]">
                      {wh.url}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {wh.events.map((event: any) => (
                        <span
                          key={event}
                          className="rounded-[5px] border border-border2 px-2 py-px font-mono text-[9.5px] font-medium leading-[1.6] text-muted-foreground"
                        >
                          {event}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-[30px] w-[30px] rounded-[7px] text-faint hover:bg-hover hover:text-foreground"
                      asChild
                    >
                      <Link href={`/dashboard/settings/webhooks/${wh.id}`}>
                        <Eye className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-[30px] w-[30px] rounded-[7px] text-faint hover:bg-hover hover:text-[#c96b56]"
                      onClick={() => remove.mutate({ id: wh.id })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function WebhooksPage() {
  return (
    <RequireAppAdmin>
      <WebhooksPageInner />
    </RequireAppAdmin>
  );
}
