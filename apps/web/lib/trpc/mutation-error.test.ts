/**
 * Unit tests for the global MutationCache fallback error handler
 * (`mutationCacheOnError`) exported from react.tsx.
 *
 * We import the REAL handler so the test cannot drift from the production
 * config, and exercise it through a MutationCache constructed exactly as
 * TRPCProvider does. No React / no DOM — toast + humanizeError are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MutationCache } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Module-level mocks: toast + humanizeError. Declared before the react.tsx
// import so its `toast` / `humanizeError` bindings resolve to the mocks.
// ---------------------------------------------------------------------------
vi.mock("~/hooks/use-toast", () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("~/lib/errors", () => ({
  humanizeError: vi.fn((err: unknown) => `humanized: ${(err as any)?.message ?? String(err)}`),
}));

// Stub the tRPC client react.tsx imports — we only need the exported handler.
vi.mock("./client", () => ({ trpc: {} }));

import { toast } from "~/hooks/use-toast";
import { humanizeError } from "~/lib/errors";
import { mutationCacheOnError } from "./react";

// A MutationCache wired with the REAL exported handler — same as TRPCProvider.
const cache = new MutationCache({ onError: mutationCacheOnError });

// Minimal Mutation-like object the callback receives.
function fakeMutation(hasOwnOnError: boolean) {
  return {
    options: hasOwnOnError ? { onError: vi.fn() } : {},
  } as any;
}

// Fire the cache's configured onError exactly the way TanStack does:
// onError(error, variables, onMutateResult, mutation, context).
function fireOnError(error: unknown, mutation: any) {
  cache.config.onError!(error as any, undefined, undefined, mutation, {} as any);
}

describe("global MutationCache fallback error handler (mutationCacheOnError)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls toast with a humanized description when the mutation has NO own onError", () => {
    const error = new Error("database connection refused");
    fireOnError(error, fakeMutation(false));

    expect(humanizeError).toHaveBeenCalledWith(error);
    expect(toast).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith({
      variant: "destructive",
      description: "humanized: database connection refused",
    });
  });

  it("does NOT call toast when the mutation HAS its own hook-level onError", () => {
    // This is how channels/page.tsx + AIPanel.tsx suppress the global handler:
    // they attach a (no-op) hook-level onError and toast in their own catch.
    fireOnError(new Error("some error"), fakeMutation(true));

    expect(toast).not.toHaveBeenCalled();
    expect(humanizeError).not.toHaveBeenCalled();
  });

  it("passes the raw error object to humanizeError (no pre-processing)", () => {
    const error = { message: "tRPC FORBIDDEN", data: { code: "FORBIDDEN" } };
    fireOnError(error, fakeMutation(false));

    expect(humanizeError).toHaveBeenCalledWith(error);
  });

  it("always uses variant 'destructive' for fallback toasts", () => {
    fireOnError(new Error("oops"), fakeMutation(false));

    const callArg = vi.mocked(toast).mock.calls[0]![0];
    expect(callArg.variant).toBe("destructive");
  });

  // -------------------------------------------------------------------------
  // Regression doc: the mutateAsync + try/catch shape (the double-toast bug).
  //
  // TanStack fires this global onError INDEPENDENTLY of (and before) any
  // try/catch around mutateAsync — `mutation.options.onError` is empty for a
  // bare `useMutation()`, so the global WOULD fire, and a catch that also
  // toasts would DOUBLE-toast. The fix at those sites (ComposeTab, channels,
  // AIPanel) ensures exactly ONE toast. The two cases below lock that contract.
  // -------------------------------------------------------------------------
  it("bare mutateAsync site (catch toast REMOVED, e.g. ComposeTab): global fires exactly once", () => {
    // Hook has no onError; its catch no longer toasts. The only toast comes
    // from the global handler → exactly one (no double-toast).
    fireOnError(new Error("AI provider down"), fakeMutation(false));
    expect(toast).toHaveBeenCalledOnce();
  });

  it("mutateAsync site keeping a richer catch toast (no-op hook onError, e.g. channels/AIPanel): global is suppressed", () => {
    // A no-op hook-level onError is present, so the global is suppressed; the
    // site's own (more-actionable) catch toast is then the single toast.
    const mutation = fakeMutation(true); // no-op onError present
    fireOnError(new Error("Could not start the OAuth flow"), mutation);

    // Global suppressed → it did not toast; the site's catch owns the UX.
    expect(toast).not.toHaveBeenCalled();
  });
});
