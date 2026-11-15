"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { Trash2 } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "~/components/ui/dialog";

/**
 * Self-service account deletion — what /data-deletion promises under
 * "Settings". Backed by user.deleteAccount (password + typed DELETE).
 */
export function DeleteAccountCard({ hasPassword }: { hasPassword: boolean }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const del = trpc.user.deleteAccount.useMutation({
    onSuccess: () => { void signOut({ callbackUrl: "/" }); },
    onError: (e) => setError(humanizeError(e)),
  });
  const ready = confirm === "DELETE" && (!hasPassword || password.length > 0) && !del.isPending;

  return (
    <div className="rounded-[14px] border border-[#d9695f]/40 bg-card p-[22px]">
      <div className="flex items-center gap-2">
        <Trash2 className="h-4 w-4 text-[#d9695f]" />
        <h2 className="text-[14.5px] font-semibold leading-[1.2]">Delete account</h2>
      </div>
      <p className="ml-6 mt-[5px] text-[12px] leading-[1.4] text-muted-foreground">
        Permanently close your account. Workspaces only you use are shut down — their channels are disconnected,
        scheduled posts are cancelled, and their posts and media are deleted within 30 days. You leave any shared
        workspaces.
      </p>
      <Button variant="destructive" className="ml-6 mt-4 h-[34px] text-[12px]" onClick={() => { setOpen(true); setError(null); }}>
        Delete my account
      </Button>

      <Dialog open={open} onOpenChange={(o) => { if (!del.isPending) setOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>This can&apos;t be undone. You&apos;ll be signed out everywhere.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {hasPassword && (
              <div className="space-y-1.5">
                <Label htmlFor="delete-password">Password</Label>
                <Input id="delete-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="delete-confirm">Type DELETE to confirm</Label>
              <Input id="delete-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
            </div>
            {error && <p className="text-[12px] text-[#d9695f]">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={del.isPending}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!ready}
              onClick={() => { setError(null); del.mutate({ password: hasPassword ? password : undefined, confirm: "DELETE" }); }}
            >
              {del.isPending ? "Deleting…" : "Delete account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
