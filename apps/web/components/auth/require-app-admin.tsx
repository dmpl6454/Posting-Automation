"use client";

import { useSession } from "next-auth/react";
import { ShieldAlert } from "lucide-react";

/**
 * Presentation guard for admin-only dashboard pages (app-level RBAC,
 * User.appRole). Real enforcement lives server-side in tRPC
 * (adminOrgProcedure / adminProtectedProcedure) — this component just replaces
 * a wall of FORBIDDEN toasts with a clear message when a USER-role account
 * deep-links into an admin area.
 *
 * Super admin implies admin (mirrors isAppAdmin in packages/api/src/trpc.ts).
 */
export function RequireAppAdmin({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  if (status === "loading") return null;
  const u = session?.user as { appRole?: string; isSuperAdmin?: boolean } | undefined;
  const ok = u?.appRole === "ADMIN" || u?.isSuperAdmin === true;
  if (!ok) {
    return (
      <div className="flex h-[60vh] items-center justify-center px-4">
        <div className="space-y-3 text-center">
          <ShieldAlert className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Admin access required</h2>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            This area is limited to workspace admins. Ask an admin to upgrade
            your role if you need access.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
