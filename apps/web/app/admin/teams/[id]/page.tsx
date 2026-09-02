"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ShieldAlert, Trash2, UserPlus } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ConfirmDialog } from "~/components/admin/ConfirmDialog";
import { useDebounce } from "~/hooks/use-debounce";
import { useToast } from "~/hooks/use-toast";

const ASSIGNABLE = ["MEMBER", "ADMIN"] as const;

export default function AdminTeamDetailPage() {
  const params = useParams<{ id: string }>();
  const organizationId = params.id;
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  const teamQuery = trpc.admin.teams.getById.useQuery({ organizationId });

  const candidates = trpc.admin.teams.searchUsers.useQuery(
    { organizationId, query: debouncedSearch },
    { enabled: debouncedSearch.trim().length > 0 }
  );

  const onError = (err: unknown) =>
    toast({
      title: "Error",
      description: humanizeError(err),
      variant: "destructive",
    });

  const refresh = () => {
    teamQuery.refetch();
    candidates.refetch();
  };

  const addMember = trpc.admin.teams.addMember.useMutation({
    onSuccess: (res) => {
      refresh();
      setSearch("");
      toast({
        title: res.alreadyMember ? "Already a member" : "Member added",
        description: res.alreadyMember
          ? "That user was already in this workspace."
          : "They now share every channel in this workspace.",
      });
    },
    onError,
  });

  const removeMember = trpc.admin.teams.removeMember.useMutation({
    onSuccess: () => {
      refresh();
      toast({ title: "Member removed" });
    },
    onError,
  });

  const updateRole = trpc.admin.teams.updateMemberRole.useMutation({
    onSuccess: () => {
      refresh();
      toast({ title: "Role updated" });
    },
    onError,
  });

  const team = teamQuery.data;
  const members = team?.members ?? [];
  const channelCount = team?._count.channels ?? 0;
  const restrictedCount = members.filter(
    (m) => m.user.appRole !== "ADMIN" && !m.user.isSuperAdmin
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
          <Link href="/admin/teams">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            All teams
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">
          {teamQuery.isLoading ? "Loading…" : team?.name ?? "Workspace"}
        </h1>
        {team && (
          <p className="text-sm text-muted-foreground">
            {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
            {channelCount} shared channel{channelCount === 1 ? "" : "s"} ·{" "}
            {team._count.posts} post{team._count.posts === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {/* Add member */}
      <Card>
        <CardHeader>
          <CardTitle>Add a member</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Everyone added here immediately shares all {channelCount} channels in
            this workspace — they can post to them and see their insights. Nothing
            is moved or copied.
          </p>
          <Input
            placeholder="Search users by email or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
          {debouncedSearch.trim().length > 0 && (
            <div className="divide-y rounded-md border">
              {candidates.isLoading && (
                <p className="p-3 text-sm text-muted-foreground">Searching…</p>
              )}
              {!candidates.isLoading && (candidates.data?.length ?? 0) === 0 && (
                <p className="p-3 text-sm text-muted-foreground">
                  No matching users who aren&apos;t already members.
                </p>
              )}
              {candidates.data?.map((u) => (
                <div
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-2 p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {u.name ?? u.email}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {u.email} · app role{" "}
                      {u.isSuperAdmin ? "super admin" : u.appRole.toLowerCase()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={addMember.isPending}
                    onClick={() =>
                      addMember.mutate({
                        organizationId,
                        userId: u.id,
                        role: "MEMBER",
                      })
                    }
                  >
                    <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                    {addMember.isPending && addMember.variables?.userId === u.id
                      ? "Adding…"
                      : "Add as member"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {restrictedCount > 0 && (
            <div className="flex gap-2 rounded-md border border-[rgba(224,184,74,0.4)] bg-[rgba(224,184,74,0.1)] p-3 text-[12.5px]">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#e0b84a]" />
              <p>
                {restrictedCount} member
                {restrictedCount === 1 ? " has" : "s have"} the app role{" "}
                <strong>user</strong>. They can post and view insights for every
                shared channel, but admin-only features (Autopilot, RSS, Campaigns,
                Brand Outreach) stay blocked regardless of their workspace role.
                Change app roles in{" "}
                <Link href="/admin/users" className="underline">
                  Users
                </Link>
                .
              </p>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Member</th>
                  <th className="py-2 pr-3 font-medium">Workspace role</th>
                  <th className="py-2 pr-3 font-medium">App role</th>
                  <th className="py-2 pr-3 font-medium">Joined</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((m) => {
                  const isOwner = m.role === "OWNER";
                  const busy =
                    updateRole.isPending &&
                    updateRole.variables?.userId === m.user.id;
                  return (
                    <tr key={m.id}>
                      <td className="py-2.5 pr-3">
                        <p className="font-medium">{m.user.name ?? m.user.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {m.user.email}
                        </p>
                      </td>
                      <td className="py-2.5 pr-3">
                        {isOwner ? (
                          <Badge>owner</Badge>
                        ) : (
                          <Select
                            value={m.role}
                            disabled={busy}
                            onValueChange={(role) =>
                              updateRole.mutate({
                                organizationId,
                                userId: m.user.id,
                                role: role as (typeof ASSIGNABLE)[number],
                              })
                            }
                          >
                            <SelectTrigger className="h-8 w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ASSIGNABLE.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {r.toLowerCase()}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        {m.user.isSuperAdmin ? (
                          <Badge variant="destructive">super admin</Badge>
                        ) : m.user.appRole === "ADMIN" ? (
                          <Badge variant="outline">admin</Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-[rgba(224,184,74,0.5)] text-[#e0b84a]"
                          >
                            user
                          </Badge>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                        {new Date(m.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-2.5">
                        {isOwner ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled
                            title="The workspace owner cannot be removed here"
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        ) : (
                          <ConfirmDialog
                            trigger={
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Remove from workspace"
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            }
                            title="Remove member from workspace?"
                            description={`${m.user.email} will immediately lose access to every channel, post and insight in this workspace. Nothing is deleted — you can add them back at any time.`}
                            confirmLabel="Remove member"
                            variant="destructive"
                            // mutateAsync (not mutate) so ConfirmDialog can await:
                            // it drives the dialog's loading state and only closes
                            // on success. A rejection keeps the dialog open while
                            // onError surfaces the toast.
                            onConfirm={async () => {
                              await removeMember.mutateAsync({
                                organizationId,
                                userId: m.user.id,
                              });
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Shared channels */}
      {team && team.channelsByPlatform.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              Shared channels ({channelCount})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {team.channelsByPlatform.map((p) => (
              <Badge key={p.platform} variant="outline">
                {p.platform.toLowerCase()} · {p.count}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
