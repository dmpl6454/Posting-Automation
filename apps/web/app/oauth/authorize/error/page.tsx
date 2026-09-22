/**
 * Where an authorization request lands when it CANNOT be sent back to the
 * client.
 *
 * ⚠️ This page exists to avoid an open redirect. If the client is unknown, or
 * the redirect URI is not one that client registered, the OAuth error must NOT
 * travel to that address — an attacker would otherwise use our authorize
 * endpoint as a redirector wearing our domain. So the failure is rendered here,
 * on our own origin, and nothing is forwarded.
 */
export const dynamic = "force-dynamic";

const REASONS: Record<string, { title: string; detail: string }> = {
  unknown_client: {
    title: "Unknown application",
    detail:
      "This application is not registered with PostAutomation, or its access has been revoked. Nothing was shared.",
  },
  bad_redirect: {
    title: "Invalid redirect address",
    detail:
      "The application asked to be sent back to an address it has not registered. This can happen if the app was misconfigured — or if the link was tampered with. Nothing was shared.",
  },
};

export default async function AuthorizeErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.reason) ? sp.reason[0] : sp.reason;
  const { title, detail } =
    REASONS[raw ?? ""] ?? {
      title: "Request could not be completed",
      detail: "This authorization request could not be processed. Nothing was shared.",
    };

  return (
    <div className="mx-auto mt-24 max-w-md px-4">
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900/40 dark:bg-red-950/30">
        <h1 className="text-base font-semibold text-red-900 dark:text-red-200">{title}</h1>
        <p className="mt-2 text-sm text-red-800 dark:text-red-300">{detail}</p>
        <a href="/dashboard" className="mt-4 inline-block text-sm underline text-red-900 dark:text-red-200">
          Back to dashboard
        </a>
      </div>
    </div>
  );
}
