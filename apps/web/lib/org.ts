"use client";

import { useSession } from "next-auth/react";

/**
 * Returns the current user's active organization ID from the JWT session.
 * Replaces the old `getOrgId()` localStorage pattern — org scope is set by
 * the backend based on the session; clients must not pass arbitrary org IDs.
 */
export function useCurrentOrgId(): string | null {
  const { data } = useSession();
  return ((data?.user as any)?.organizationId as string | undefined) ?? null;
}
