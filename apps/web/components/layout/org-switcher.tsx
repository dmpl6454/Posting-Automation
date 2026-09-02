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
import { ChevronsUpDown, Plus, Building2, Check } from "lucide-react";
import { CreateOrgDialog } from "~/components/layout/create-org-dialog";

/** Two-letter monogram for the gold tile, e.g. "Acme Content" → "AC". */
function orgInitials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("");
  return (letters || name.slice(0, 2)).toUpperCase().slice(0, 2);
}

export function OrgSwitcher() {
  const router = useRouter();
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const { data: me } = trpc.user.me.useQuery();
  // Plan tier reads as the second line of the switcher (design: name over tier).
  // Same query + staleTime the sidebar already uses, so this is a cache hit.
  const { data: planData } = trpc.billing.currentPlan.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });

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
          {/* Design restyle: gold monogram tile + org name over plan tier.
              The bordered card around this lives in the sidebar, so the
              trigger itself is borderless and fills it. */}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
          >
            <span className="pa-gold-glow flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-gold text-[10px] font-semibold leading-none text-[hsl(var(--gold-foreground))]">
              {orgInitials(currentOrgName)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium leading-[1.3]">
                {currentOrgName}
              </span>
              {planData?.planConfig?.name && (
                <span className="block text-[10px] leading-[1.3] text-muted-foreground">
                  {planData.planConfig.name}
                </span>
              )}
            </span>
            <ChevronsUpDown className="h-[13px] w-[13px] shrink-0 text-muted-foreground" />
          </button>
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
