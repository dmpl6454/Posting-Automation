"use client";

import { humanizeError } from "~/lib/errors";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useToast } from "~/hooks/use-toast";
import { Users, Plus, Trash2, Shield, Crown, MoreHorizontal, Zap } from "lucide-react";

const roleConfig: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; icon: any }> = {
  OWNER: { variant: "default", icon: Crown },
  ADMIN: { variant: "secondary", icon: Shield },
  MEMBER: { variant: "outline", icon: Users },
};

export default function TeamPage() {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("MEMBER");

  // State for the "Make Owner" confirmation dialog
  const [transferTarget, setTransferTarget] = useState<{ id: string; name: string } | null>(null);

  const { data: me } = trpc.user.me.useQuery();
  const { data: members, isLoading, refetch } = trpc.team.members.useQuery();
  const { data: usage } = trpc.billing.usage.useQuery();
  const invite = trpc.team.invite.useMutation({
    onSuccess: (data: any) => {
      setEmail("");
      refetch();
      // Fix #69-71: show correct message based on whether user was directly added or invited via email
      if (data.status === "added") {
        toast({ title: "Member added", description: `${email} has been added as ${role.toLowerCase()}.` });
      } else {
        toast({ title: "Invitation sent", description: `An invite email was sent to ${email}.` });
      }
    },
    onError: (err) => {
      toast({ title: "Failed to invite", description: humanizeError(err), variant: "destructive" });
    },
  });
  const removeMember = trpc.team.removeMember.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Member removed" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to remove", description: humanizeError(err), variant: "destructive" });
    },
  });
  const updateRole = trpc.team.updateRole.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Role updated", description: "Member role has been changed" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update role", description: humanizeError(err), variant: "destructive" });
    },
  });

  // Fix #72: ownership transfer mutation
  const transferOwnership = trpc.team.transferOwnership.useMutation({
    onSuccess: () => {
      setTransferTarget(null);
      refetch();
      toast({ title: "Ownership transferred", description: "You are now an Admin." });
    },
    onError: (err: any) => {
      setTransferTarget(null);
      toast({ title: "Transfer failed", description: humanizeError(err), variant: "destructive" });
    },
  });

  // Determine if the current user is the OWNER of the organization
  const currentUserIsOwner = members?.some(
    (m: any) => m.user.id === me?.id && m.role === "OWNER"
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Team</h1>
        <p className="text-muted-foreground">Manage your team members and roles</p>
      </div>

      {/* Plan limit warning */}
      {usage && !usage.teamMembers.allowed && (
        <Alert className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <Zap className="h-4 w-4 text-amber-600" />
          <AlertDescription className="flex items-center justify-between gap-4">
            <span className="text-amber-800 dark:text-amber-200 text-sm">
              You&apos;ve reached the <strong>{usage.teamMembers.planName}</strong> plan limit of{" "}
              <strong>{usage.teamMembers.limit} team member{usage.teamMembers.limit !== 1 ? "s" : ""}</strong>.
              Upgrade to invite more.
            </span>
            <Button asChild size="sm" className="shrink-0">
              <Link href="/dashboard/settings/billing">Upgrade Plan</Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Invite Form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Invite Team Member</CardTitle>
          <CardDescription>Send an invitation to join your organization</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="flex-1"
              disabled={usage && !usage.teamMembers.allowed}
            />
            <Select value={role} onValueChange={setRole} disabled={usage && !usage.teamMembers.allowed}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => invite.mutate({ email, role: role as any })}
              disabled={!email || invite.isPending || (usage && !usage.teamMembers.allowed)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Invite
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Members List */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Members</CardTitle>
          <CardDescription>{members?.length || 0} team member{members?.length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : (
            <div className="divide-y">
              {members?.map((member: any) => {
                const config = (roleConfig[member.role] ?? roleConfig.MEMBER)!;
                const initials = (member.user.name || member.user.email || "U")
                  .split(" ")
                  .map((n: string) => n[0])
                  .join("")
                  .toUpperCase()
                  .slice(0, 2);
                const isCurrentUser = member.user.id === me?.id;

                return (
                  <div key={member.id} className="flex items-center gap-4 px-6 py-4">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="truncate font-medium">
                        {member.user.name || member.user.email}
                        {isCurrentUser && (
                          <span className="ml-2 text-xs text-muted-foreground font-normal">(you)</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{member.user.email}</p>
                    </div>

                    {/* Role selector (owner can change non-owner roles) */}
                    {member.role !== "OWNER" && currentUserIsOwner ? (
                      <Select
                        value={member.role}
                        onValueChange={(newRole: any) =>
                          updateRole.mutate({ memberId: member.id, role: newRole })
                        }
                      >
                        <SelectTrigger className="w-28 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ADMIN">Admin</SelectItem>
                          <SelectItem value="MEMBER">Member</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant={config.variant}>{member.role}</Badge>
                    )}

                    {/* Actions dropdown — shown for non-owner members when viewer is current owner */}
                    {member.role !== "OWNER" && currentUserIsOwner && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Member actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              setTransferTarget({
                                id: member.id,
                                name: member.user.name || member.user.email,
                              })
                            }
                          >
                            <Crown className="mr-2 h-4 w-4 text-yellow-500" />
                            Make Owner
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => {
                              if (confirm(`Remove ${member.user.name || member.user.email} from the organization?`))
                                removeMember.mutate({ memberId: member.id });
                            }}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Transfer Ownership Confirmation Dialog */}
      <Dialog open={!!transferTarget} onOpenChange={(open) => { if (!open) setTransferTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer Ownership</DialogTitle>
            <DialogDescription>
              Are you sure you want to make <strong>{transferTarget?.name}</strong> the owner of this
              organization? You will be demoted to Admin and will no longer have owner privileges.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTransferTarget(null)}
              disabled={transferOwnership.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={transferOwnership.isPending}
              onClick={() => {
                if (transferTarget) {
                  transferOwnership.mutate({ newOwnerMemberId: transferTarget.id });
                }
              }}
            >
              {transferOwnership.isPending ? "Transferring…" : "Transfer Ownership"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
