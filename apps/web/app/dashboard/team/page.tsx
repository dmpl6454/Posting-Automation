"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useToast } from "~/hooks/use-toast";
import { Users, Plus, Trash2, Shield, Crown } from "lucide-react";

const roleConfig: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; icon: any }> = {
  OWNER: { variant: "default", icon: Crown },
  ADMIN: { variant: "secondary", icon: Shield },
  MEMBER: { variant: "outline", icon: Users },
  VIEWER: { variant: "outline", icon: Users },
};

export default function TeamPage() {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("MEMBER");

  const { data: me } = trpc.user.me.useQuery();
  const { data: members, isLoading, refetch } = trpc.team.members.useQuery();
  const invite = trpc.team.invite.useMutation({
    onSuccess: () => {
      setEmail("");
      refetch();
      toast({ title: "Invitation sent", description: `Invited ${email} as ${role.toLowerCase()}` });
    },
    onError: (err) => {
      toast({ title: "Failed to invite", description: err.message, variant: "destructive" });
    },
  });
  const removeMember = trpc.team.removeMember.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Member removed" });
    },
  });
  const updateRole = trpc.team.updateRole.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Role updated", description: "Member role has been changed" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update role", description: err.message, variant: "destructive" });
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
            />
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
                <SelectItem value="VIEWER">Viewer</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => invite.mutate({ email, role: role as any })}
              disabled={!email || invite.isPending}
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

                return (
                  <div key={member.id} className="flex items-center gap-4 px-6 py-4">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="truncate font-medium">
                        {member.user.name || member.user.email}
                      </p>
                      <p className="text-xs text-muted-foreground">{member.user.email}</p>
                    </div>
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
                          <SelectItem value="VIEWER">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant={config.variant}>{member.role}</Badge>
                    )}
                    {member.role !== "OWNER" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          if (confirm("Remove this member?"))
                            removeMember.mutate({ memberId: member.id });
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
