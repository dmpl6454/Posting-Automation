"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Button } from "~/components/ui/button";
import { ChevronsUpDown, Plus, Building2, Check } from "lucide-react";
import { CreateOrgDialog } from "~/components/layout/create-org-dialog";

export function OrgSwitcher() {
  const router = useRouter();
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const { data: me } = trpc.user.me.useQuery();

  // Load the stored org ID from localStorage on mount
  useEffect(() => {
    const storedOrgId = localStorage.getItem("currentOrgId");
    if (storedOrgId) {
      setCurrentOrgId(storedOrgId);
    }
  }, []);

  // Auto-select first org if none is stored
  useEffect(() => {
    if (me?.memberships && me.memberships.length > 0 && !currentOrgId) {
      const firstOrg = (me.memberships as any[])[0];
      const orgId = firstOrg.organization?.id || firstOrg.organizationId;
      if (orgId) {
        setCurrentOrgId(orgId);
        localStorage.setItem("currentOrgId", orgId);
      }
    }
  }, [me, currentOrgId]);

  const memberships: any[] = me?.memberships || [];

  const currentOrg = memberships.find(
    (m: any) => (m.organization?.id || m.organizationId) === currentOrgId
  );

  const currentOrgName = currentOrg?.organization?.name || "Select Organization";

  const handleSwitch = (orgId: string) => {
    setCurrentOrgId(orgId);
    localStorage.setItem("currentOrgId", orgId);
    router.push("/dashboard");
    router.refresh();
  };

  const handleOrgCreated = (orgId: string) => {
    setShowCreateDialog(false);
    handleSwitch(orgId);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-between gap-2 px-3"
          >
            <span className="flex items-center gap-2 truncate">
              <Building2 className="h-4 w-4 shrink-0" />
              <span className="truncate text-sm">{currentOrgName}</span>
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="start">
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {memberships.map((membership: any) => {
            const orgId =
              membership.organization?.id || membership.organizationId;
            const orgName =
              membership.organization?.name || "Unnamed Organization";
            const isActive = orgId === currentOrgId;

            return (
              <DropdownMenuItem
                key={orgId}
                onClick={() => handleSwitch(orgId)}
                className="cursor-pointer"
              >
                <span className="flex flex-1 items-center gap-2">
                  <Building2 className="h-4 w-4" />
                  <span className="truncate">{orgName}</span>
                </span>
                {isActive && <Check className="h-4 w-4 shrink-0" />}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setShowCreateDialog(true)}
            className="cursor-pointer"
          >
            <Plus className="mr-2 h-4 w-4" />
            Create Organization
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateOrgDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleOrgCreated}
      />
    </>
  );
}
