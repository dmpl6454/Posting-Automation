/**
 * "Delete from Facebook / Instagram" request state (2026-11-05), shared by the
 * web process (which queues a request) and the worker (which runs it), so both
 * read and write the same record the same way.
 *
 * The record lives at PostTarget.metadata.platformDelete. A target that WAS
 * deleted also gets PostTarget.platformDeletedAt; its status stays PUBLISHED so
 * its history and Insights are kept.
 *
 * ⚠️ Every write is an ATOMIC jsonb merge (`metadata || …`), never a whole-column
 * rewrite: other workers write sibling keys of the same column concurrently
 * (resolvedPostId, firstComment, superTextMedia …).
 */

export type PlatformDeleteStatus = "queued" | "deleting" | "deleted" | "not_found" | "failed";

export interface PlatformDeleteRecord {
  status: PlatformDeleteStatus;
  requestedAt: string;
  requestedBy?: string | null;
  message?: string | null;
  finishedAt?: string | null;
}

/** A queued/deleting record older than this is treated as lost and may be requested again. */
export const PLATFORM_DELETE_STALE_MS = 30 * 60_000;

const STATUSES: readonly PlatformDeleteStatus[] = ["queued", "deleting", "deleted", "not_found", "failed"];

export function readPlatformDeleteRecord(metadata: unknown): PlatformDeleteRecord | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const rec = (metadata as Record<string, unknown>).platformDelete;
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  if (!STATUSES.includes(r.status as PlatformDeleteStatus)) return null;
  return {
    status: r.status as PlatformDeleteStatus,
    requestedAt: typeof r.requestedAt === "string" ? r.requestedAt : "",
    requestedBy: typeof r.requestedBy === "string" ? r.requestedBy : null,
    message: typeof r.message === "string" ? r.message : null,
    finishedAt: typeof r.finishedAt === "string" ? r.finishedAt : null,
  };
}

/** True while a request is genuinely running (not lost). */
export function isPlatformDeleteInFlight(rec: PlatformDeleteRecord | null, now: Date): boolean {
  if (!rec || (rec.status !== "queued" && rec.status !== "deleting")) return false;
  const at = Date.parse(rec.requestedAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < PLATFORM_DELETE_STALE_MS;
}

type RawClient = {
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>;
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
};

/**
 * Atomically marks the given targets `queued` and returns the ids it claimed.
 * A target is claimable only if it is PUBLISHED, not already deleted from the
 * platform, and has no in-flight request (a lost one older than
 * PLATFORM_DELETE_STALE_MS may be claimed again). Two simultaneous requests for
 * the same target therefore queue it once.
 */
export async function claimTargetsForPlatformDelete(
  prisma: RawClient,
  targetIds: string[],
  record: { requestedAt: Date; requestedBy: string | null }
): Promise<string[]> {
  if (targetIds.length === 0) return [];
  const rec: PlatformDeleteRecord = {
    status: "queued",
    requestedAt: record.requestedAt.toISOString(),
    requestedBy: record.requestedBy,
    message: null,
    finishedAt: null,
  };
  const staleBefore = new Date(record.requestedAt.getTime() - PLATFORM_DELETE_STALE_MS).toISOString();
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE "PostTarget"
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('platformDelete', $2::jsonb),
            "updatedAt" = now()
      WHERE id = ANY($1::text[])
        AND status::text = 'PUBLISHED'
        AND "publishedId" IS NOT NULL
        AND "platformDeletedAt" IS NULL
        AND (
          metadata->'platformDelete'->>'status' IS NULL
          OR metadata->'platformDelete'->>'status' NOT IN ('queued', 'deleting')
          OR COALESCE(metadata->'platformDelete'->>'requestedAt', '') < $3
        )
      RETURNING id`,
    targetIds,
    JSON.stringify(rec),
    staleBefore
  )) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Merges a patch into the record. `onlyIfStatus` makes it a compare-and-set
 * (returns 0 when the record is not in one of those states); `deletedAt` also
 * stamps PostTarget.platformDeletedAt.
 */
export async function updatePlatformDeleteRecord(
  prisma: RawClient,
  targetId: string,
  patch: Partial<PlatformDeleteRecord>,
  opts: { onlyIfStatus?: PlatformDeleteStatus[]; deletedAt?: Date } = {}
): Promise<number> {
  const params: unknown[] = [targetId, JSON.stringify(patch)];
  let guard = "";
  if (opts.onlyIfStatus && opts.onlyIfStatus.length > 0) {
    params.push(opts.onlyIfStatus);
    guard = ` AND metadata->'platformDelete'->>'status' = ANY($${params.length}::text[])`;
  }
  let stamp = "";
  if (opts.deletedAt) {
    // Prisma stores DateTime as UTC in a timestamp WITHOUT time zone.
    params.push(opts.deletedAt.toISOString());
    stamp = `, "platformDeletedAt" = ($${params.length}::timestamptz AT TIME ZONE 'UTC')`;
  }
  return prisma.$executeRawUnsafe(
    `UPDATE "PostTarget"
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'platformDelete',
              COALESCE(metadata->'platformDelete', '{}'::jsonb) || $2::jsonb
            ),
            "updatedAt" = now()${stamp}
      WHERE id = $1${guard}`,
    ...params
  );
}
