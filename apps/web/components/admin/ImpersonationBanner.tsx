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
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-4 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
      <span>You are impersonating a user</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 border-white bg-transparent text-white hover:bg-white hover:text-amber-600"
        onClick={() => stopImpersonation.mutate()}
        disabled={stopImpersonation.isPending}
      >
        {stopImpersonation.isPending ? "Exiting..." : "Exit"}
      </Button>
    </div>
  );
}
