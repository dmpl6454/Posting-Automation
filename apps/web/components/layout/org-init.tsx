"use client";

import { useEffect } from "react";
import { trpc } from "~/lib/trpc/client";

/**
 * Auto-fetches and stores the current user's organization ID in localStorage.
 * This ensures all tRPC requests include the org ID header.
 */
export function OrgInit() {
  const { data } = trpc.org.current.useQuery(undefined, {
    staleTime: 30_000, // Refresh org every 30s instead of never
    retry: 1,
  });

  useEffect(() => {
    if (data?.id) {
      const current = localStorage.getItem("currentOrgId");
      if (current !== data.id) {
        localStorage.setItem("currentOrgId", data.id);
        // Always reload when org ID changes to ensure tRPC client picks up the new ID
        window.location.reload();
      }
    }
  }, [data?.id]);

  return null;
}
