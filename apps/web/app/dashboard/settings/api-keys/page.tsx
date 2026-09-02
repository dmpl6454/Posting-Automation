"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { humanizeError } from "~/lib/errors";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { DateTimePicker } from "~/components/ui/datetime-picker";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import { Key, Plus, Trash2, Copy, AlertTriangle } from "lucide-react";

/* Design tokens for this page (see the Settings page for why these are local
   rather than shared helpers). */
const CARD = "rounded-[14px] border border-border bg-card p-[22px]";
const CARD_TITLE = "text-[14.5px] font-semibold leading-[1.2]";
const FIELD_38 =
  "h-[38px] rounded-[8px] border-border2 bg-background px-3 text-[12.5px]";
/* Literal hex: this project's Tailwind config flattens the amber/yellow scale
   onto the palette's warning triplet, so `bg-amber-50 text-amber-800` renders
   the label the same colour as its background. */
const WARN = "#e0b84a";

function ApiKeysPageInner() {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const { data: apiKeys, isLoading, refetch } = trpc.apikey.list.useQuery();
  const create = trpc.apikey.create.useMutation({
    onSuccess: (data) => {
      setName("");
      setExpiresAt("");
      setRevealedKey(data.key);
      refetch();
      toast({ title: "API key created" });
    },
    onError: (err) => {
      toast({ title: "Failed to create API key", description: humanizeError(err), variant: "destructive" });
    },
  });
  const remove = trpc.apikey.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "API key deleted" });
    },
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Fix #87: hide the key immediately after copy — shown exactly once
    setRevealedKey(null);
    toast({ title: "Key copied", description: "It will not be shown again. Store it in a safe place." });
  };

  return (
    <div className="w-full">
      {/* Page header — eyebrow / display title / subtitle (design restyle) */}
      <div className="min-w-0">
        <span className="eyebrow">API Keys</span>
        <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
          Access, programmatically.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Manage API access to your account
        </p>
      </div>

      {/* Revealed Key Warning */}
      {revealedKey && (
        <div
          className="mt-5 rounded-[14px] border p-[22px]"
          style={{ borderColor: `${WARN}55`, background: `${WARN}14` }}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-px h-[17px] w-[17px] shrink-0"
              style={{ color: WARN }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium leading-[1.5]" style={{ color: WARN }}>
                Make sure to copy your API key now. You won&apos;t be able to see it again!
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <code
                  className="min-w-0 flex-1 truncate rounded-[8px] px-3 py-2 font-mono text-[12px]"
                  style={{ background: `${WARN}1f`, color: WARN }}
                >
                  {revealedKey}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-[8px]"
                  style={{ borderColor: `${WARN}55` }}
                  onClick={() => copyToClipboard(revealedKey)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create API Key — the design keeps name / expiry / CTA on one row. */}
      <div className={`mt-[22px] ${CARD}`}>
        <h2 className={CARD_TITLE}>Create API Key</h2>
        <p className="mt-[5px] text-[12px] leading-[1.5] text-muted-foreground">
          Generate a new key to access the API programmatically
        </p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Production, CI/CD, Development"
            className={`min-w-[200px] flex-1 ${FIELD_38}`}
          />
          <div className="w-[180px] shrink-0">
            <DateTimePicker
              value={expiresAt}
              onChange={setExpiresAt}
              min={new Date().toISOString().slice(0, 16)}
              placeholder="No expiration"
              className={FIELD_38}
            />
          </div>
          <Button
            className="pa-cta-gold h-[38px] shrink-0 gap-1.5 rounded-[8px] px-[15px] text-[12.5px] font-semibold"
            onClick={() =>
              create.mutate({
                name,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
              })
            }
            disabled={!name || create.isPending}
          >
            <Plus className="h-[13px] w-[13px]" />
            Create API Key
          </Button>
        </div>
      </div>

      {/* Existing API Keys */}
      <div className="mt-4 overflow-hidden rounded-[14px] border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-[22px] py-[18px]">
          <h2 className={CARD_TITLE}>Active Keys</h2>
          <span className="text-[11.5px] font-medium leading-none text-faint">
            {apiKeys?.length || 0} configured
          </span>
        </div>
        {isLoading ? (
          <div className="space-y-3 p-[22px]">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-14 rounded-[10px]" />
            ))}
          </div>
        ) : apiKeys?.length === 0 ? (
          <div className="flex flex-col items-center py-12">
            <Key className="h-8 w-8 text-tile" />
            <p className="mt-2.5 text-[12.5px] text-muted-foreground">No API keys created</p>
          </div>
        ) : (
          apiKeys?.map((ak: any) => (
            <div
              key={ak.id}
              className="flex items-center gap-3.5 border-b border-border px-[22px] py-4 last:border-b-0"
            >
              <Key className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium leading-[1.3]">{ak.name}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                  <span className="rounded-[5px] border border-border2 px-2 py-px font-mono text-[9.5px] font-semibold leading-[1.6] text-muted-foreground">
                    {ak.keyPrefix}
                  </span>
                  <span className="text-[11px] leading-none text-faint">
                    Created {new Date(ak.createdAt).toLocaleDateString()}
                  </span>
                  <span className="text-[11px] leading-none text-faint">
                    {ak.lastUsedAt
                      ? `Last used ${new Date(ak.lastUsedAt).toLocaleDateString()}`
                      : "Never used"}
                  </span>
                  <span className="text-[11px] leading-none text-faint">
                    {ak.expiresAt
                      ? `Expires ${new Date(ak.expiresAt).toLocaleDateString()}`
                      : "Never expires"}
                  </span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-[30px] w-[30px] shrink-0 rounded-[7px] text-faint hover:bg-hover hover:text-[#c96b56]"
                onClick={() => remove.mutate({ id: ak.id })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function ApiKeysPage() {
  return (
    <RequireAppAdmin>
      <ApiKeysPageInner />
    </RequireAppAdmin>
  );
}
