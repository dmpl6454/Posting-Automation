"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { humanizeError } from "~/lib/errors";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { Avatar, AvatarFallback } from "~/components/ui/avatar";
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

/**
 * Design: role is a tinted pill with a 10px glyph — the same shape for every
 * member, so the column lines up whether or not the viewer can change it.
 *
 * ADMIN's blue is literal hex: this project's Tailwind config flattens the
 * status scales, and `--accent-border` is the palette's dark gold edge (the
 * app token for the mockup's `--gold-border`).
 */
const ROLE_META: Record<string, { label: string; Icon: typeof Crown; pill: string }> = {
  OWNER:  { label: "Owner",  Icon: Crown,  pill: "border border-[hsl(var(--accent-border))] bg-gold/[0.12] text-gold" },
  ADMIN:  { label: "Admin",  Icon: Shield, pill: "bg-[rgba(91,155,213,0.15)] text-[#5b9bd5]" },
  MEMBER: { label: "Member", Icon: Users,  pill: "bg-tile text-muted-foreground" },
};

/** The design's 38px form control, shared by the invite input and role select. */
const FIELD_38 =
  "h-[38px] rounded-[8px] border-border2 bg-background px-3 text-[12.5px]";

function TeamPageInner() {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("MEMBER");

  // State for the "Make Owner" confirmation dialog
  const [transferTarget, setTransferTarget] = useState<{ id: string; name: string } | null>(null);

  const { data: me } = trpc.user.me.useQuery();
  const { data: members, isLoading, refetch } = trpc.team.members.useQuery();
  // Super admins manage APP access roles (User/Admin) in the /admin console —
  // surface that here, since Team is where people naturally look for "roles".
  const { data: session } = useSession();
  const isSuperAdmin = (session?.user as any)?.isSuperAdmin === true;
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
    /* Design stacks sections on 20px, not 24px. */
    <div className="w-full space-y-5">
      {/* Page header — design pattern (eyebrow, display headline, sub). */}
      <div className="min-w-0">
        <span className="eyebrow">Team</span>
        <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
          Bring in your people.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Manage your team members and roles
        </p>
      </div>

      {/* Where APP access roles (User/Admin) are managed — workspace roles below
          are org membership; the app-wide access tier lives in the Admin console. */}
      {/* Design: a quiet surface-1 note, not the Alert component's framing. */}
      {isSuperAdmin && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
          <p className="min-w-0 text-[12px] leading-[1.65] text-muted-foreground">
            Looking for <b className="text-foreground">app access roles</b> (User / Admin — which
            pages someone can use)? Those are managed per user in the Admin console.
          </p>
          <Link
            href="/admin/users"
            className="shrink-0 rounded-[8px] border border-border2 bg-surface2 px-3 py-1.5 text-[11.5px] font-medium hover:bg-hover"
          >
            Open Admin → Users
          </Link>
        </div>
      )}

      {/* Plan limit warning — kept visually distinct from the note above (it is
          a block, not an aside), but in the palette's amber rather than raw
          Tailwind, whose amber scale this project flattens. */}
      {usage && !usage.teamMembers.allowed && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-[12px] border border-[rgba(224,184,74,0.3)] bg-[rgba(224,184,74,0.12)] px-4 py-3.5">
          <div className="flex min-w-0 items-start gap-3">
            <Zap className="mt-px h-[15px] w-[15px] shrink-0 text-[#e0b84a]" />
            <p className="min-w-0 text-[12px] leading-[1.65] text-[#e0b84a]">
              You&apos;ve reached the <b>{usage.teamMembers.planName}</b> plan limit of{" "}
              <b>{usage.teamMembers.limit} team member{usage.teamMembers.limit !== 1 ? "s" : ""}</b>.
              Upgrade to invite more.
            </p>
          </div>
          <Button asChild size="sm" className="pa-cta-gold h-8 shrink-0 rounded-[8px] px-3.5 text-[12px] font-semibold">
            <Link href="/dashboard/settings/billing">Upgrade Plan</Link>
          </Button>
        </div>
      )}

      {/* Invite Form */}
      <div className="rounded-[14px] border border-border bg-card p-[22px]">
        <h2 className="text-[14.5px] font-semibold leading-[1.2]">Invite Team Member</h2>
        <p className="mt-[5px] text-[12px] leading-[1.5] text-muted-foreground">
          Send an invitation to join your organization
        </p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@company.com"
            className={`${FIELD_38} min-w-[220px] flex-1`}
            disabled={usage && !usage.teamMembers.allowed}
          />
          <Select value={role} onValueChange={setRole} disabled={usage && !usage.teamMembers.allowed}>
            <SelectTrigger className={`${FIELD_38} w-full shrink-0 sm:w-[110px]`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MEMBER">Member</SelectItem>
              <SelectItem value="ADMIN">Admin</SelectItem>
            </SelectContent>
          </Select>
          <Button
            className="pa-cta-gold h-[38px] w-full shrink-0 gap-[7px] rounded-[8px] px-4 text-[12.5px] font-semibold sm:w-auto"
            onClick={() => invite.mutate({ email, role: role as any })}
            disabled={!email || invite.isPending || (usage && !usage.teamMembers.allowed)}
          >
            <Plus className="h-3.5 w-3.5" />
            Invite
          </Button>
        </div>
      </div>

      {/* Members List */}
      <div className="overflow-hidden rounded-[14px] border border-border bg-card">
        <div className="border-b border-border px-[22px] py-[18px]">
          <h2 className="text-[14.5px] font-semibold leading-[1.2]">Members</h2>
          <p className="mt-[5px] text-[12px] leading-[1.4] text-muted-foreground">
            {members?.length || 0} team member{members?.length !== 1 ? "s" : ""}
          </p>
        </div>
        {isLoading ? (
          <div className="space-y-3 p-[22px]">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-[38px]" />
            ))}
          </div>
        ) : (
          <div>
            {members?.map((member: any) => {
              const rm = ROLE_META[member.role] ?? ROLE_META.MEMBER!;
              const initials = (member.user.name || member.user.email || "U")
                .split(" ")
                .map((n: string) => n[0])
                .join("")
                .toUpperCase()
                .slice(0, 2);
              const isCurrentUser = member.user.id === me?.id;
              const canManage = member.role !== "OWNER" && currentUserIsOwner;

              return (
                <div
                  key={member.id}
                  className="flex items-center gap-3.5 border-b border-border px-[22px] py-4"
                >
                  {/* Design: a solid accent disc with near-black initials. */}
                  <Avatar className="h-[38px] w-[38px] shrink-0">
                    <AvatarFallback className="bg-gold text-[13px] font-bold text-[hsl(var(--gold-foreground))]">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium leading-[1.3]">
                      {member.user.name || member.user.email}
                      {isCurrentUser && (
                        <span className="ml-[7px] text-[11px] font-normal text-faint">(you)</span>
                      )}
                    </p>
                    <p className="mt-[3px] truncate text-[11.5px] leading-[1.3] text-muted-foreground">
                      {member.user.email}
                    </p>
                  </div>

                  {/* Design: EVERY member shows the same role pill. The app used
                      to swap in a <Select> for changeable members, so the column
                      jumped width and rows stopped lining up depending on who
                      was looking. Changing a role now lives in the ⋯ menu. */}
                  <span
                    className={`flex shrink-0 items-center gap-[5px] rounded-full px-2.5 py-[3px] text-[10.5px] font-semibold leading-[1.6] ${rm.pill}`}
                  >
                    <rm.Icon className="h-2.5 w-2.5" />
                    {rm.label}
                  </span>

                  {/* Actions dropdown — non-owner members, viewer is the owner */}
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-[30px] w-[30px] shrink-0 rounded-[7px] text-muted-foreground hover:bg-hover hover:text-foreground"
                        >
                          <MoreHorizontal className="h-[15px] w-[15px]" />
                          <span className="sr-only">Member actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[170px]">
                        {(["MEMBER", "ADMIN"] as const)
                          .filter((r) => r !== member.role)
                          .map((r) => (
                            <DropdownMenuItem
                              key={r}
                              className="text-[12px] font-medium"
                              onClick={() => updateRole.mutate({ memberId: member.id, role: r as any })}
                            >
                              Set as {ROLE_META[r]!.label}
                            </DropdownMenuItem>
                          ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-[12px] font-medium"
                          onClick={() =>
                            setTransferTarget({
                              id: member.id,
                              name: member.user.name || member.user.email,
                            })
                          }
                        >
                          <Crown className="mr-2 h-3 w-3 text-gold" />
                          Make Owner
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-[12px] font-medium text-[#c96b56] focus:text-[#c96b56]"
                          onClick={() => {
                            if (confirm(`Remove ${member.user.name || member.user.email} from the organization?`))
                              removeMember.mutate({ memberId: member.id });
                          }}
                        >
                          <Trash2 className="mr-2 h-3 w-3" />
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
      </div>

      {/* Transfer Ownership Confirmation Dialog */}
      <Dialog open={!!transferTarget} onOpenChange={(open) => { if (!open) setTransferTarget(null); }}>
        <DialogContent className="rounded-[14px] p-6 sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold leading-[1.2]">
              Transfer Ownership
            </DialogTitle>
            <DialogDescription className="text-[12.5px] leading-[1.6]">
              Are you sure you want to make{" "}
              <b className="text-foreground">{transferTarget?.name}</b> the owner of this
              organization? You will be demoted to Admin and will no longer have owner privileges.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2.5">
            <Button
              variant="outline"
              className="h-9 rounded-[9px] border-border2 bg-surface2 px-[15px] text-[12.5px] font-medium hover:bg-hover"
              onClick={() => setTransferTarget(null)}
              disabled={transferOwnership.isPending}
            >
              Cancel
            </Button>
            {/* Design: terracotta, not the destructive red — this hands over
                ownership, it does not delete anything. */}
            <Button
              className="h-9 rounded-[9px] bg-[#c96b56] px-[15px] text-[12.5px] font-semibold text-[#1a1712] hover:bg-[#c96b56] hover:brightness-110"
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

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function TeamPage() {
  return (
    <RequireAppAdmin>
      <TeamPageInner />
    </RequireAppAdmin>
  );
}
