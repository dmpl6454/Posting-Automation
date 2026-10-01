/**
 * The active workspace, as the tRPC client sends it. Plain `fetch` calls to
 * org-scoped routes (e.g. /api/upload) must send the same header, or the server
 * falls back to the user's default org while tRPC checks the active one.
 */
export const ORG_HEADER = "x-organization-id";
const ORG_ID_STORAGE_KEY = "currentOrgId";

export function getCurrentOrgId(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(ORG_ID_STORAGE_KEY) || "";
  } catch {
    // Storage blocked (sandboxed iframe, disabled site data): let the server pick.
    return "";
  }
}

export function orgHeaders(): Record<string, string> {
  const orgId = getCurrentOrgId();
  return orgId ? { [ORG_HEADER]: orgId } : {};
}
