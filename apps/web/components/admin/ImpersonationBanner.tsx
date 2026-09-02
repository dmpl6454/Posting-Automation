"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "~/components/ui/button";
import { trpc } from "~/lib/trpc/client";

export function ImpersonationBanner() {
  const [isImpersonating, setIsImpersonating] = useState(false);
  const router = useRouter();
  const stopImpersonation = trpc.admin.users.stopImpersonation.useMutation({
    onSuccess: () => {
      document.cookie =
        "admin-impersonate=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
      // While impersonating, OrgInit stored the impersonated user's org in
      // localStorage. If we leave it, the admin's own subsequent requests keep
      // sending that stale org as x-organization-id — which then mismatches the
      // admin's real channels and breaks publishing ("channels do not belong to
      // this organization"). Clear it so OrgInit re-seeds the admin's own org.
      localStorage.removeItem("currentOrgId");
      setIsImpersonating(false);
      router.push("/admin/users");
    },
  });

  useEffect(() => {
    const hasImpersonateCookie = document.cookie
      .split(";")
      .some((c) => c.trim().startsWith("admin-impersonate="));
    setIsImpersonating(hasImpersonateCookie);
  }, []);

  if (!isImpersonating) return null;

  return (
    /* Literal hex — `bg-amber-500` resolves to the flattened warning triplet,
       which is not the design's amber. */
    <div
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-4 px-4 py-2 text-[12.5px] font-medium"
      style={{ background: "#e0b84a", color: "#1a1712" }}
    >
      <span>You are impersonating a user</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 rounded-[7px] border-[#1a1712]/40 bg-transparent text-[12px] font-semibold text-[#1a1712] hover:bg-[#1a1712] hover:text-[#e0b84a]"
        onClick={() => stopImpersonation.mutate()}
        disabled={stopImpersonation.isPending}
      >
        {stopImpersonation.isPending ? "Exiting..." : "Exit"}
      </Button>
    </div>
  );
}
