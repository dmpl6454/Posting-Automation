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
import { Key, Plus, Trash2, Copy, AlertTriangle } from "lucide-react";

export default function ApiKeysPage() {
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
      toast({ title: "Failed to create API key", description: err.message, variant: "destructive" });
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
    toast({ title: "Copied to clipboard" });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
        <p className="text-muted-foreground">Manage API access to your account</p>
      </div>

      {/* Revealed Key Warning */}
      {revealedKey && (
        <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  Make sure to copy your API key now. You won&apos;t be able to see it again!
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-amber-100 px-3 py-2 font-mono text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                    {revealedKey}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0 border-amber-300"
                    onClick={() => copyToClipboard(revealedKey)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create API Key */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Create API Key</CardTitle>
          <CardDescription>Generate a new key to access the API programmatically</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Key Name</Label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production, CI/CD, Development"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Expiration (optional)</Label>
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
          <Button
            onClick={() =>
              create.mutate({
                name,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
              })
            }
            disabled={!name || create.isPending}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create API Key
          </Button>
        </CardContent>
      </Card>

      {/* Existing API Keys */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Active Keys</CardTitle>
          <CardDescription>{apiKeys?.length || 0} API key{apiKeys?.length !== 1 ? "s" : ""} configured</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {[1, 2].map((i) => <Skeleton key={i} className="h-14" />)}
            </div>
          ) : apiKeys?.length === 0 ? (
            <div className="flex flex-col items-center py-12">
              <Key className="h-8 w-8 text-muted-foreground/30" />
              <p className="mt-2 text-sm text-muted-foreground">No API keys created</p>
            </div>
          ) : (
            <div className="divide-y">
              {apiKeys?.map((ak: any) => (
                <div key={ak.id} className="flex items-center gap-4 px-6 py-4">
                  <Key className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{ak.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {ak.keyPrefix}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        Created {new Date(ak.createdAt).toLocaleDateString()}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {ak.lastUsedAt
                          ? `Last used ${new Date(ak.lastUsedAt).toLocaleDateString()}`
                          : "Never used"}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {ak.expiresAt
                          ? `Expires ${new Date(ak.expiresAt).toLocaleDateString()}`
                          : "Never expires"}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => remove.mutate({ id: ak.id })}
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
