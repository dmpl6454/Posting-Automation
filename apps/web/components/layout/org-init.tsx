"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "~/lib/trpc/client";

/**
 * Reconciles localStorage `currentOrgId` (the value the tRPC client sends as the
 * x-organization-id header) with the server's resolved active org.
 *
 * `org.current` is header-aware: if localStorage already holds an org the user can
 * access, the server echoes it back and we do nothing — so a deliberate org-switch
 * survives. If localStorage holds a stale/inaccessible org (e.g. left over from a
 * stopped impersonation session), the server returns the user's real org; we write
 * that and resync.
 *
 * The tRPC client reads `currentOrgId` from localStorage on EVERY request
 * (see `headers()` in lib/trpc/react.tsx), so once we correct localStorage the next
 * request already carries the right header — a full `window.location.reload()` is
 * unnecessary. Instead we invalidate the tRPC cache (so client queries refetch with
 * the corrected header) and `router.refresh()` (so server components re-render). This
 * avoids the jarring full-page reload that used to fire ~2s after landing on the
 * dashboard and could wipe an in-progress interaction (e.g. a tab the user just
 * selected snapping back). `router.refresh()`/invalidate preserve client component
 * state, so any selection the user made survives the resync.
 */
export function OrgInit() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data } = trpc.org.current.useQuery(undefined, {
    staleTime: 30_000, // Refresh org every 30s instead of never
    retry: 1,
  });

  useEffect(() => {
    if (!data?.id) return;
    const current = localStorage.getItem("currentOrgId");
    if (current === data.id) return; // already in sync — no work, no refetch

    localStorage.setItem("currentOrgId", data.id);
    // Guard against a double-fire within the same tab session (the write above
    // already makes the next poll a no-op, but this is belt-and-suspenders against
    // a fast re-render before the localStorage write is observed).
    const guardKey = `orgInitSyncedFor:${data.id}`;
    if (sessionStorage.getItem(guardKey)) return;
    sessionStorage.setItem(guardKey, "1");
    // Soft resync — no full-page reload. Next tRPC request carries the corrected
    // x-organization-id header; invalidate makes everything refetch under it.
    void utils.invalidate();
    router.refresh();
  }, [data?.id, router, utils]);

  return null;
}
