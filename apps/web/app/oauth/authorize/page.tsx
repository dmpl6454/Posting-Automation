import { redirect } from "next/navigation";
import { auth } from "~/lib/auth";
import { prisma } from "@postautomation/db";
import {
  narrowToClientScopes,
  parseScopeParam,
  redirectUriAllowed,
  SCOPE_DESCRIPTIONS,
  type McpScope,
} from "@postautomation/api/src/lib/mcp-oauth";
import { decideAuthorization } from "./actions";

/**
 * The consent screen an MCP client sends the user to.
 *
 * This is the ONLY point at which a human authorises an AI client to act on
 * their workspace, so it has to show enough to make that decision real: which
 * app is asking, where it will be sent back to, which workspace it gets, and
 * what it will be able to do.
 *
 * ⚠️ Dynamic Client Registration is open, so `client_name` is attacker-chosen.
 * The redirect URI is displayed precisely because it is NOT — it is the one
 * field a plausible-sounding impostor cannot fake.
 */
export const dynamic = "force-dynamic";

function ErrorPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mx-auto mt-24 max-w-md rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900/40 dark:bg-red-950/30">
      <h1 className="text-base font-semibold text-red-900 dark:text-red-200">{title}</h1>
      <p className="mt-2 text-sm text-red-800 dark:text-red-300">{detail}</p>
    </div>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? (sp[k] as string[])[0] : (sp[k] as string | undefined)) ?? "";

  const clientId = one("client_id");
  const redirectUri = one("redirect_uri");
  const responseType = one("response_type");
  const codeChallenge = one("code_challenge");
  const codeChallengeMethod = one("code_challenge_method");
  const state = one("state");
  const resource = one("resource");
  const scopeParam = one("scope");

  if (!clientId || !redirectUri) {
    return <ErrorPanel title="Invalid request" detail="Missing client_id or redirect_uri." />;
  }

  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId } });
  if (!client || client.revokedAt) {
    return <ErrorPanel title="Unknown application" detail="This application is not registered, or its access was revoked." />;
  }

  /**
   * 🔴 The open-redirect gate. Until the redirect URI is proven to be one THIS
   * client registered, nothing may be sent to it — not a code, and not an error.
   * Everything above this line renders on our own origin.
   */
  if (!redirectUriAllowed(redirectUri, client.redirectUris)) {
    return (
      <ErrorPanel
        title="Invalid redirect"
        detail="This application asked to be sent back to an address it has not registered. Nothing was shared."
      />
    );
  }

  if (responseType !== "code") {
    return <ErrorPanel title="Unsupported request" detail="Only the authorization code flow is supported." />;
  }
  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    return (
      <ErrorPanel
        title="Insecure request"
        detail="This application must use PKCE with S256. Older methods are not accepted."
      />
    );
  }

  // Not signed in ⇒ log in and come straight back to this exact request.
  const session = await auth();
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) {
    const self = new URL("https://placeholder.invalid/oauth/authorize");
    for (const [k, v] of Object.entries(sp)) {
      const val = Array.isArray(v) ? v[0] : v;
      if (typeof val === "string") self.searchParams.set(k, val);
    }
    redirect(`/login?callbackUrl=${encodeURIComponent(self.pathname + self.search)}`);
  }

  // Requested scopes, narrowed to what we define. An empty/absent request gets
  // the full set — the spec's guidance is that scopes_supported is the default
  // when the client does not ask for something narrower.
  // ⚠️ Narrowed by the client's REGISTERED ceiling as well as by what we define,
  // so the screen can never describe access the server action will refuse (or,
  // worse, describe less than it grants). actions.ts applies the same filter
  // authoritatively — this one only keeps the display honest.
  const scopes: McpScope[] = narrowToClientScopes(parseScopeParam(scopeParam), client.scopes);

  if (scopes.length === 0) {
    return (
      <ErrorPanel
        title="Nothing to approve"
        detail="This application asked for access that it is not registered to receive."
      />
    );
  }

  // Which workspace this token will act on. Same deterministic ordering the rest
  // of the app uses (OWNER first, then oldest) so the default here matches the
  // workspace the user sees when they sign in.
  const memberships = await prisma.organizationMember.findMany({
    where: { userId: userId! },
    select: { organizationId: true, role: true, organization: { select: { name: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  if (memberships.length === 0) {
    return <ErrorPanel title="No workspace" detail="Your account is not a member of any workspace." />;
  }

  const clientHost = (() => {
    try {
      return new URL(redirectUri).host || redirectUri;
    } catch {
      return redirectUri;
    }
  })();

  return (
    <div className="mx-auto mt-16 max-w-lg px-4">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Connect an AI assistant</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <strong className="text-foreground">{client.clientName}</strong> is asking to connect to your
          PostAutomation account.
        </p>

        <div className="mt-4 rounded-md border bg-muted/40 p-3 text-xs">
          {/* The one field an impostor cannot fake — shown so a plausible name
              alone is not enough to earn consent. */}
          <div className="text-muted-foreground">It will be sent back to</div>
          <div className="mt-0.5 break-all font-mono">{clientHost}</div>
        </div>

        <form action={decideAuthorization} className="mt-5 space-y-5">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="state" value={state} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <input type="hidden" name="code_challenge_method" value={codeChallengeMethod} />
          <input type="hidden" name="resource" value={resource} />
          <input type="hidden" name="scope" value={scopes.join(" ")} />

          <div>
            <label className="text-sm font-medium" htmlFor="organization_id">
              Workspace
            </label>
            <select
              id="organization_id"
              name="organization_id"
              defaultValue={memberships[0]!.organizationId}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              {memberships.map((m) => (
                <option key={m.organizationId} value={m.organizationId}>
                  {m.organization?.name ?? m.organizationId}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              The assistant will only be able to act on this workspace.
            </p>
          </div>

          <div>
            <div className="text-sm font-medium">This will allow it to</div>
            <ul className="mt-2 space-y-1.5">
              {scopes.map((s) => (
                <li key={s} className="flex gap-2 text-sm">
                  <span aria-hidden className="mt-0.5 text-muted-foreground">
                    •
                  </span>
                  <span
                    className={
                      s === "mcp:publish" ? "font-medium text-amber-700 dark:text-amber-400" : undefined
                    }
                  >
                    {SCOPE_DESCRIPTIONS[s]}
                  </span>
                </li>
              ))}
            </ul>
            {scopes.includes("mcp:publish") && (
              // Named separately because it is the irreversible one: a published
              // post reaches a live audience and cannot be recalled.
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
                Publishing is immediate and cannot be undone. Anything this assistant publishes goes to your
                real audience.
              </p>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              name="decision"
              value="allow"
              className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Allow
            </button>
            <button
              type="submit"
              name="decision"
              value="deny"
              className="flex-1 rounded-md border px-4 py-2 text-sm font-medium"
            >
              Deny
            </button>
          </div>
        </form>
      </div>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        You can revoke this at any time from Settings &rarr; Connected apps.
      </p>
    </div>
  );
}
