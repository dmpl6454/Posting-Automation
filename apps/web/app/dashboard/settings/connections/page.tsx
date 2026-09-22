import Link from "next/link";
import { redirect } from "next/navigation";
import { Bot, ShieldOff } from "lucide-react";
import { auth } from "~/lib/auth";
import { prisma } from "@postautomation/db";
import { SCOPE_DESCRIPTIONS, type McpScope } from "@postautomation/api/src/lib/mcp-oauth";
import { revokeMcpClient } from "./actions";

/**
 * Connected AI apps (2026-09-22).
 *
 * The other half of the MCP consent screen: what you approved, and how to take
 * it back. A server component reading Prisma directly, like the admin layout —
 * there is no tRPC router for MCP grants and one procedure's worth of data does
 * not justify inventing one.
 */
export const dynamic = "force-dynamic";

const CARD = "rounded-[14px] border border-border bg-card p-[22px]";

export default async function ConnectionsPage() {
  const session = await auth();
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) redirect("/login?callbackUrl=%2Fdashboard%2Fsettings%2Fconnections");

  const tokens = await prisma.mcpAccessToken.findMany({
    where: { userId, revokedAt: null, refreshExpiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: {
      clientId: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      organizationId: true,
    },
  });

  // Several live tokens per connector is normal — every refresh mints one. The
  // user thinks in terms of apps, so collapse to the client and keep the most
  // recent activity.
  const byClient = new Map<
    string,
    { clientId: string; scopes: string[]; createdAt: Date; lastUsedAt: Date | null; orgIds: Set<string> }
  >();
  for (const t of tokens) {
    const existing = byClient.get(t.clientId);
    if (!existing) {
      byClient.set(t.clientId, {
        clientId: t.clientId,
        scopes: [...t.scopes],
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        orgIds: new Set([t.organizationId]),
      });
      continue;
    }
    for (const s of t.scopes) if (!existing.scopes.includes(s)) existing.scopes.push(s);
    existing.orgIds.add(t.organizationId);
    if (t.lastUsedAt && (!existing.lastUsedAt || t.lastUsedAt > existing.lastUsedAt)) {
      existing.lastUsedAt = t.lastUsedAt;
    }
  }

  const clientIds = [...byClient.keys()];
  const clients = clientIds.length
    ? await prisma.mcpOAuthClient.findMany({
        where: { clientId: { in: clientIds } },
        select: { clientId: true, clientName: true },
      })
    : [];
  const nameOf = new Map(clients.map((c) => [c.clientId, c.clientName]));

  const orgIds = [...new Set(tokens.map((t) => t.organizationId))];
  const orgs = orgIds.length
    ? await prisma.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true },
      })
    : [];
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  const grants = [...byClient.values()];

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Connected apps</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          AI assistants you have given access to this account. Revoking takes effect immediately —
          the app is signed out and cannot refresh.
        </p>
      </div>

      {grants.length === 0 ? (
        <div className={CARD}>
          <p className="text-sm text-muted-foreground">
            No AI assistants are connected. You can add one from Claude or ChatGPT using this
            workspace&rsquo;s connector URL.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {grants.map((g) => (
            <div key={g.clientId} className={CARD}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-[14.5px] font-semibold">
                      {nameOf.get(g.clientId) ?? "Unknown application"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Connected {g.createdAt.toLocaleDateString()} ·{" "}
                    {g.lastUsedAt ? `last used ${g.lastUsedAt.toLocaleString()}` : "never used"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Workspace
                    {g.orgIds.size > 1 ? "s" : ""}:{" "}
                    {[...g.orgIds].map((id) => orgName.get(id) ?? id).join(", ")}
                  </p>

                  <ul className="mt-3 space-y-1">
                    {g.scopes.map((s) => (
                      <li key={s} className="text-xs text-muted-foreground">
                        &middot; {SCOPE_DESCRIPTIONS[s as McpScope] ?? s}
                      </li>
                    ))}
                  </ul>
                </div>

                <form action={revokeMcpClient}>
                  <input type="hidden" name="clientId" value={g.clientId} />
                  <button
                    type="submit"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                  >
                    <ShieldOff className="h-3.5 w-3.5" />
                    Revoke
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Resetting your password also disconnects every AI assistant.{" "}
        <Link href="/dashboard/settings" className="underline">
          Account settings
        </Link>
      </p>
    </div>
  );
}
