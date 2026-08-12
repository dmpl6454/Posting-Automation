/**
 * Corrects the Insights verdict on channels that a reconnect could not reach.
 *
 * The bug this fixes (root-caused live on prod 2026-08-12)
 * ───────────────────────────────────────────────────────
 * The Meta OAuth callback upserts ONLY the pages/accounts the platform returns
 * for this consent. A page the user does not tick is therefore never visited —
 * so its channel row keeps whatever `metadata.insightsHealth` it last had. That
 * verdict then becomes permanent, because the only other thing that clears it is
 * a clean capture (`shouldApplyHealthVerdict`), and captures keep failing.
 *
 * Measured on the reporting org: ONE consent on 2026-08-11 granted 72 pages and
 * healed all 72 channels; a single page left out of that grant kept a verdict
 * written on 2026-08-10 saying *"The platform rejected the stored access token.
 * Reconnect this channel."* The owner reconnected — correctly, repeatedly — and
 * the banner never cleared, because the reconnect provably never touched that
 * row. The banner was telling the truth about the symptom and lying about the
 * remedy.
 *
 * So: after a successful connect, re-stamp the channels that were left out with
 * a verdict that names what actually happened.
 *
 * ⚠️ Deliberately NARROW — only channels ALREADY carrying `needs_reconnect` are
 * touched. A workspace may legitimately hold two different platform logins, each
 * granting a different set of pages; reconnecting login B must not slander
 * login A's perfectly healthy channels as "not granted". Restricting to rows
 * that are already failing means the worst case is a *more accurate message on
 * an already-broken channel*, never a false alarm on a working one.
 *
 * Pure selection + copy live here and are unit-tested; the single Prisma write
 * is a thin loop at the bottom.
 */
import { readInsightsHealth } from "./insights-health";

/**
 * Machine reason stamped on a channel the latest consent did not include.
 * Kept ≤40 chars so `readInsightsHealth` preserves it (it drops longer strings).
 */
export const ORPHANED_GRANT_REASON = "not_in_latest_grant";

/** Bounds the work a single connect can trigger. */
export const MAX_ORPHANS_PER_CONNECT = 300;

export interface OrphanCandidate {
  id: string;
  platformId: string;
  metadata: unknown;
}

export interface OrphanedGrantHealth {
  status: "needs_reconnect";
  reason: string;
  detail: string;
  checkedAt: string;
}

/**
 * The corrected verdict. The wording has to hold for BOTH causes we cannot tell
 * apart through the API — the account was left unticked, or the person's role on
 * it changed — because naming the wrong one sends the owner to the wrong screen.
 * It also names the escape hatch, since an account the owner no longer manages
 * would otherwise nag forever with no way to act.
 */
export function buildOrphanedGrantHealth(
  platformLabel: string,
  now: Date = new Date()
): OrphanedGrantHealth {
  return {
    status: "needs_reconnect",
    reason: ORPHANED_GRANT_REASON,
    detail:
      `This account was not included in the most recent ${platformLabel} connection for this ` +
      `workspace, so it still cannot report Insights. Reconnect and choose "Edit settings", then ` +
      `tick it in the list. If it is not listed, it is no longer available to the profile you ` +
      `connect with — pause or disconnect this channel to stop the reminder.`,
    checkedAt: now.toISOString(),
  };
}

/**
 * Which of these channels the just-completed consent left behind.
 *
 * @param candidates          the org's active channels on the connected platform
 * @param grantedPlatformIds  platform ids the consent DID return
 */
export function selectOrphanedChannels(
  candidates: OrphanCandidate[],
  grantedPlatformIds: Iterable<string>
): OrphanCandidate[] {
  const granted = new Set(grantedPlatformIds);
  // A connect that returned nothing is not evidence that everything was
  // dropped — it is evidence that something went wrong upstream. Fail closed:
  // stamping the whole workspace off the back of an empty grant would be far
  // worse than leaving the verdicts alone.
  if (granted.size === 0) return [];

  return candidates.filter((c) => {
    if (granted.has(c.platformId)) return false;
    const health = readInsightsHealth(c.metadata);
    // Only already-failing channels — see the "deliberately NARROW" note above.
    if (health?.status !== "needs_reconnect") return false;
    // Idempotent: a second reconnect must not rewrite an identical verdict.
    if (health.reason === ORPHANED_GRANT_REASON) return false;
    return true;
  });
}

/**
 * Merges the verdict into existing metadata WITHOUT dropping sibling keys.
 * `metadata` carries `igUserId` / `pageId` / `userAccessToken` /
 * `dataAccessExpiresAt`; clobbering any of those breaks posting or the
 * data-access cliff warning.
 */
export function mergeOrphanedGrantHealth(
  existingMetadata: unknown,
  verdict: OrphanedGrantHealth
): Record<string, unknown> {
  const base =
    existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? (existingMetadata as Record<string, unknown>)
      : {};
  return { ...base, insightsHealth: verdict };
}

/** Minimal Prisma surface, so tests need no generated client. */
interface ChannelWriter {
  channel: {
    findMany(args: unknown): Promise<OrphanCandidate[]>;
    update(args: unknown): Promise<unknown>;
  };
}

/**
 * Re-stamps the channels this consent could not reach. Best-effort by contract:
 * the caller runs it AFTER the channels are saved, and a failure here must never
 * fail a connect that already succeeded.
 *
 * @returns how many channels were corrected
 */
export async function markChannelsMissingFromGrant(
  prisma: ChannelWriter,
  organizationId: string,
  platform: string,
  grantedPlatformIds: string[],
  platformLabel: string,
  now: Date = new Date()
): Promise<number> {
  if (grantedPlatformIds.length === 0) return 0;

  const candidates = await prisma.channel.findMany({
    where: {
      organizationId,
      platform,
      isActive: true,
      disconnectedAt: null,
      platformId: { notIn: grantedPlatformIds },
    },
    select: { id: true, platformId: true, metadata: true },
    take: MAX_ORPHANS_PER_CONNECT,
  });

  const orphans = selectOrphanedChannels(candidates, grantedPlatformIds);
  if (orphans.length === 0) return 0;

  const verdict = buildOrphanedGrantHealth(platformLabel, now);
  for (const o of orphans) {
    await prisma.channel.update({
      where: { id: o.id },
      data: { metadata: mergeOrphanedGrantHealth(o.metadata, verdict) },
    });
  }
  return orphans.length;
}
