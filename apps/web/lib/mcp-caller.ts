import { prisma } from "@postautomation/db";
import { appRouter, createCallerFactory } from "@postautomation/api";
import type { McpAuthContext } from "./mcp-verify-token";

/**
 * Bridge from a verified MCP token to the platform's own tRPC procedures
 * (2026-09-21).
 *
 * 🔴 THIS IS THE TRUST BOUNDARY. Everything an AI client can do flows through
 * here, so the synthesized identity must be no more privileged than the human
 * who consented — and demonstrably so.
 */

/**
 * Build a tRPC caller acting as the token's user, in the token's workspace.
 *
 * ⚠️ `isSuperAdmin` is FORCED FALSE, unconditionally. Two reasons, both severe:
 *   1. `superAdminProcedure` gates solely on this flag, so inheriting it would
 *      hand an LLM the cross-organization admin surface.
 *   2. `requirePlan` and `enforcePlanLimit` both early-return for a superadmin,
 *      so inheriting it would silently remove every quota and spend brake.
 * The codebase already made exactly this call for impersonation
 * (buildImpersonatedSession in packages/api/src/trpc.ts), for the same reasons.
 * An owner's key must not be more powerful than an ordinary member's.
 *
 * ⚠️ `impersonationToken` is NEVER passed. `createTRPCContext` accepts one and
 * `protectedProcedure` will swap the acting user if it verifies — so forwarding
 * request headers wholesale here would let a client name any identity it liked.
 * The context is built field by field, deliberately, rather than spread.
 *
 * ⚠️ `organizationId` comes from the TOKEN, never from a request header. The
 * token was bound to one workspace at consent time; `orgProcedure` then
 * re-checks a real membership row, so a tampered value fails closed rather than
 * reaching another org.
 */
export function buildMcpCaller(ctx: McpAuthContext) {
  const session = {
    user: {
      id: ctx.userId,
      isSuperAdmin: false,
      /**
       * ⚠️ PRESENT DELIBERATELY. `protectedProcedure` gates on
       * `ctx.session.user.isBanned`, and `undefined` is falsy — omitting this
       * field would let a suspended account keep using its connector. The value
       * is read fresh from the User row on every request in verifyMcpToken, so
       * it is never a stale snapshot from consent time.
       */
      isBanned: ctx.isBanned,
      /**
       * ⚠️ `appRole` is ABSENT ON PURPOSE, not by oversight. `isAppAdmin` reads
       * it, so leaving it undefined means every app-admin router (rss, agent,
       * autopilot, campaign, webhook, apikey, audit, team management, billing
       * checkout…) is closed to the connector regardless of the human's own
       * role. None of the MCP tools need it — they are all orgProcedure — and an
       * LLM holding an owner's admin surface is a far worse failure than a tool
       * returning FORBIDDEN. Do not "fix" this by copying appRole through.
       */
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  } as any;

  return createCallerFactory(appRouter)({
    prisma,
    session,
    organizationId: ctx.organizationId,
    // impersonationToken intentionally absent — see above.
  } as any);
}

/**
 * Strip platform credentials out of anything on its way to a model.
 *
 * 🔴 Channel rows carry `accessToken` / `refreshToken` / `userAccessToken`, and
 * several routers return them as a nested relation
 * (`targets: { include: { channel: true } }` appears in post.list, post.getById,
 * post.update and others). Those nested reads are NOT intercepted by the Prisma
 * decryption extension — the extension fires only when `channel` is the
 * top-level model — so they arrive as `enc:v1:` ciphertext. A direct channel
 * read arrives as PLAINTEXT.
 *
 * Either way it is secret material, and an MCP tool result goes into the model's
 * context and therefore to the model vendor. So this runs over EVERY tool
 * result, recursively, keyed on field name rather than on value shape — a
 * value-shape test would pass for ciphertext and fail open for plaintext.
 */
const SECRET_KEYS = new Set([
  "accessToken",
  "refreshToken",
  "userAccessToken",
  "keyHash",
  "tokenHash",
  "refreshTokenHash",
  "clientSecretHash",
  "codeHash",
  "password",
  "webhookSecret",
  "apiKey",
  // OAuth material, in case a future tool ever reaches these tables.
  "clientSecret",
  "codeChallenge",
  "codeVerifier",
  "access_token",
  "refresh_token",
  "client_secret",
  // Credential-bearing channel config: Telegram bot tokens, Discord webhook
  // URLs, Mastodon/WordPress app passwords all arrive under these names.
  "botToken",
  "webhookUrl",
  "appPassword",
  "secret",
]);

export function redactSecrets<T>(value: T, depth = 0): T {
  // Cheap recursion guard: platform payloads are shallow, and a cycle would
  // otherwise hang the request.
  if (depth > 12) return "[truncated]" as unknown as T;
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
  }
  // Dates and other non-plain objects pass through untouched.
  if (value instanceof Date) return value;
  if (typeof value === "bigint") {
    // Media.fileSize is a Prisma BigInt and JSON.stringify throws on it.
    return Number(value) as unknown as T;
  }
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = v == null ? v : "[redacted]";
      continue;
    }
    out[k] = redactSecrets(v, depth + 1);
  }
  return out as T;
}
