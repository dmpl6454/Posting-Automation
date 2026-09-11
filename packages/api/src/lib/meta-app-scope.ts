import { legacyMetaCredentials, type MetaPlatform } from "@postautomation/social";

/**
 * Builds the Prisma `Channel` predicate that selects exactly the channels
 * belonging to ONE Meta app.
 *
 * ── Why this is a shared helper and not an inline object ─────────────────────
 * Two call sites need it and both are security-relevant:
 *
 *   - `enqueueFacebookFeedAnalytics` — a webhook signed by app B must not be
 *     able to trigger work against app A's Pages.
 *   - `markChannelsMissingFromGrant` — a consent under app B must not stamp
 *     "reconnect this channel" on app A's channels. Getting this wrong
 *     re-creates the perpetual-reconnect-banner incident of 2026-08-12, at
 *     ~1,338-channel scale.
 *
 * ── 🔴 Why it is an OR and not `{ metaAppId: { in: [appId, null] } }` ────────
 * Legacy rows carry `metaAppId = NULL`, and in SQL `x IN (NULL, 'a')` NEVER
 * matches a NULL row — `NULL = NULL` is unknown, not true. An `in` containing
 * null silently excludes every pre-existing channel, which for the webhook path
 * means analytics quietly stop for all 1,338 of them.
 *
 * ── 🔴 Why `appId` is required and validated ─────────────────────────────────
 * Prisma treats `where: { metaAppId: undefined }` as NO FILTER AT ALL, so an
 * accidentally-undefined app id would widen the query to every channel in the
 * table rather than narrowing it — the documented `{ id: undefined }` trap.
 * tsc cannot catch that, because Prisma types the field as optional. Passing a
 * non-string here throws instead.
 */
export function metaAppChannelScope(
  platform: MetaPlatform,
  appId: string
): { metaAppId: string } | { OR: Array<{ metaAppId: string | null }> } {
  if (typeof appId !== "string" || appId.trim().length === 0) {
    throw new Error(
      `metaAppChannelScope: appId must be a non-empty string (got ${JSON.stringify(appId)}). ` +
        `An undefined value would be treated by Prisma as "no filter" and widen the query.`
    );
  }

  const legacy = legacyMetaCredentials(platform);

  // The legacy app owns BOTH rows explicitly stamped with its id and every
  // pre-existing row, which has NULL.
  if (legacy && legacy.appId === appId) {
    return { OR: [{ metaAppId: null }, { metaAppId: appId }] };
  }

  return { metaAppId: appId };
}
