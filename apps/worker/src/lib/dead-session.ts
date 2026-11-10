import {
  PUBLISH_SESSION_DEAD_KEY,
  DEAD_SESSION_PLATFORMS,
  buildPublishSessionDeadRecord,
} from "@postautomation/queue";

/**
 * Record a dead Meta session on the channel (2026-11-10). See
 * packages/queue/src/publish-session-dead.ts for the contract.
 *
 * ATOMIC jsonb merge — never a whole-column rewrite: the analytics worker and
 * the comment router write sibling keys (insightsHealth, grantedScopes) into the
 * same column concurrently. NEVER THROWS: the caller is already failing the
 * target with the real reason; bookkeeping must not replace that error.
 */
export async function recordDeadSession(
  db: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> },
  channelId: string,
  token: string | null | undefined,
  platform: string,
  reason: string
): Promise<boolean> {
  if (!token || !DEAD_SESSION_PLATFORMS.has(platform)) return false;
  try {
    const record = JSON.stringify(buildPublishSessionDeadRecord(token, platform, reason));
    await db.$executeRaw`UPDATE "Channel" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(${PUBLISH_SESSION_DEAD_KEY}::text, ${record}::jsonb) WHERE "id" = ${channelId}`;
    return true;
  } catch (err: any) {
    console.warn(`[PostPublish] could not record dead session on channel ${channelId}: ${err?.message ?? err}`);
    return false;
  }
}
