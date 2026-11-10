import { orgProcedure } from "../trpc";
import { readOrgCache, writeOrgCache, isAnalyticsCacheEnabled, invalidateOrgAnalyticsCache } from "./cache";

/**
 * `orgProcedure` whose result is served from Redis for ANALYTICS_CACHE_TTL_S
 * (2026-11-10). Use only for READ-ONLY queries whose output depends on nothing
 * but the organization and the input — never on the calling user, and never
 * for mutations.
 *
 * The key is the tRPC path + the RAW input (this middleware runs before the
 * input parser), scoped by the authenticated `ctx.organizationId` and the
 * org's cache version. Errors are never cached.
 */
export const cachedOrgProcedure = orgProcedure.use(async ({ ctx, path, type, getRawInput, next }) => {
  if (type !== "query" || !isAnalyticsCacheEnabled()) return next();
  const organizationId = (ctx as { organizationId?: string }).organizationId;
  if (!organizationId) return next();

  let rawInput: unknown;
  try {
    rawInput = await getRawInput();
  } catch {
    return next();
  }

  const read = await readOrgCache<unknown>(organizationId, path, rawInput);
  if (read.hit) {
    // A middleware result is `{ ok, data }`; tRPC only reads those two fields.
    return { ok: true, data: read.value, marker: undefined } as unknown as Awaited<ReturnType<typeof next>>;
  }
  const result = await next();
  if (result.ok) await writeOrgCache(read.key, result.data);
  return result;
});

/**
 * `orgProcedure` that drops the org's cached Insights after a SUCCESSFUL
 * mutation (channel connect/disconnect/pause, group membership). Queries pass
 * straight through.
 */
export const insightsInvalidatingOrgProcedure = orgProcedure.use(async ({ ctx, type, next }) => {
  const result = await next();
  if (type === "mutation" && result.ok) {
    invalidateOrgAnalyticsCache((ctx as { organizationId?: string }).organizationId);
  }
  return result;
});
