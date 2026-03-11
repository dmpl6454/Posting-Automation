"use client";

import { useEffect } from "react";
import { trpc } from "~/lib/trpc/client";

/**
 * Auto-fetches and stores the current user's organization ID in localStorage.
 * This ensures all tRPC requests include the org ID header.
 */
export function OrgInit() {
  const { data } = trpc.org.current.useQuery(undefined, {
    staleTime: Infinity,
    retry: 1,
  });

  useEffect(() => {
    if (data?.id) {
      const current = localStorage.getItem("currentOrgId");
      if (current !== data.id) {
        localStorage.setItem("currentOrgId", data.id);
        // Reload to ensure tRPC client picks up the new org ID
        if (!current) {
          window.location.reload();
        }
      }
    }
  }, [data?.id]);

  return null;
}
