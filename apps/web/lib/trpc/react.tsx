"use client";

import { useState } from "react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./client";
import { toast } from "~/hooks/use-toast";
import { humanizeError } from "~/lib/errors";

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  return process.env.NEXTAUTH_URL || "http://localhost:3000";
}

/**
 * fetch wrapper for the tRPC link: intercepts NON-JSON error responses
 * (e.g. nginx's HTML 429 rate-limit page, gateway HTML error pages) BEFORE
 * @trpc/client calls res.json() on them. Without this, the raw SyntaxError
 * ("Unexpected token '<' ... is not valid JSON") lands verbatim in
 * TRPCClientError.message with meta undefined — the 429 status is
 * unrecoverable from the error object, so it must be handled here.
 * Real tRPC error envelopes are 4xx/5xx WITH application/json and MUST
 * pass through untouched.
 */
async function guardedFetch(
  input: RequestInfo | URL | string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    // Only intercept NON-JSON error bodies. A JSON body — even a 429 — is a real
    // tRPC error envelope (e.g. the app's own TOO_MANY_REQUESTS with an
    // actionable reset-time message) and MUST reach @trpc/client's parser so its
    // code/data survive. Only nginx/gateway HTML pages (no application/json) are
    // remapped here, since those would otherwise throw a raw JSON SyntaxError.
    if (!contentType.includes("application/json")) {
      if (res.status === 429) {
        throw new Error("Too many requests - please wait a moment and try again.");
      }
      throw new Error("The server returned an unexpected response. Please try again.");
    }
  }
  return res;
}

/**
 * Global fallback error handler for tRPC mutations.
 *
 * TanStack fires MutationCache.onError for EVERY failing mutation, so this acts
 * as a safety net: any mutation that rejects without surfacing its own error
 * toast still shows the user a destructive toast (resolves the class of
 * "silent-fail button" bugs).
 *
 * ⚠️ The `mutation.options.onError` guard ONLY covers HOOK-LEVEL onError
 * (i.e. `useMutation({ onError })` / tRPC `.useMutation({ onError })`). It does
 * NOT — and cannot — detect error handling done with an imperative
 * `mutateAsync()` / `mutate()` call wrapped in a try/catch, because:
 *   1. `mutation.options.onError` is empty for those sites, and
 *   2. this global handler fires INDEPENDENTLY of (and before) any catch block.
 * So a site that ALSO toasts inside a catch around `mutateAsync` would
 * double-toast. The fix for those sites is either (a) DROP the redundant catch
 * toast and let this handler own the error UX (done for ComposeTab.tsx), or
 * (b) keep a more-actionable catch toast and add a no-op hook-level
 * `onError: () => {}` so this guard skips it (done for channels/page.tsx and
 * AIPanel.tsx). If you add a new mutateAsync+try/catch site, pick one of those
 * two — do NOT toast in the catch AND rely on the global. Always keep any
 * non-toast cleanup (state resets, dialog close) in the catch.
 */
export const mutationCacheOnError: NonNullable<NonNullable<ConstructorParameters<typeof MutationCache>[0]>["onError"]> = (
  error,
  _variables,
  _onMutateResult,
  mutation
) => {
  // Skip when the mutation defines its own hook-level onError (it toasts itself).
  if (mutation.options.onError) return;
  toast({ variant: "destructive", description: humanizeError(error) });
};

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        mutationCache: new MutationCache({ onError: mutationCacheOnError }),
        defaultOptions: {
          queries: { staleTime: 5 * 1000, refetchOnWindowFocus: false },
        },
      })
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          fetch: guardedFetch,
          headers() {
            const orgId = typeof window !== "undefined"
              ? localStorage.getItem("currentOrgId") || ""
              : "";
            return {
              "x-organization-id": orgId,
            };
          },
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
