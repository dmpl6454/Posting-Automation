"use client";

import { useEffect } from "react";
import { trpc } from "~/lib/trpc/client";

/**
 * Reconciles localStorage `currentOrgId` (the value the tRPC client sends as the
 * x-organization-id header) with the server's resolved active org.
 *
 * `org.current` is header-aware: if localStorage already holds an org the user can
 * access, the server echoes it back and we do nothing — so a deliberate org-switch
 * survives. If localStorage holds a stale/inaccessible org (e.g. left over from a
 * stopped impersonation session), the server returns the user's real org; we write
 * that and reload ONCE. After the reload, localStorage matches the server's answer,
 * so the next poll is a no-op — no reload loop.
 */
export function OrgInit() {
  const { data } = trpc.org.current.useQuery(undefined, {
    staleTime: 30_000, // Refresh org every 30s instead of never
    retry: 1,
  });

  useEffect(() => {
    if (!data?.id) return;
    const current = localStorage.getItem("currentOrgId");
    if (current === data.id) return; // already in sync — no work, no reload

    localStorage.setItem("currentOrgId", data.id);
    // Reload so the tRPC client picks up the corrected header. Guard against a
    // double-fire within the same tab session (the write above already makes the
    // next poll a no-op, but this is belt-and-suspenders against a fast re-render).
    const guardKey = `orgInitReloadedFor:${data.id}`;
    if (sessionStorage.getItem(guardKey)) return;
    sessionStorage.setItem(guardKey, "1");
    window.location.reload();
  }, [data?.id]);

  return null;
}
