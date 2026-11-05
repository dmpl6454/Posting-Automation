import {
  updatePlatformDeleteRecord,
  type PlatformDeleteRecord,
} from "@postautomation/queue";
import {
  isPlatformDeletePlatform,
  platformDeleteCapability,
  platformDeleteMissingScopeMessage,
  type PlatformDeleteOutcome,
  type PlatformDeletePlatform,
} from "@postautomation/social";

/**
 * Runs ONE "delete from Facebook / Instagram" job (2026-11-05).
 *
 * The API claimed the target `queued`; this run moves it `queued|deleting →
 * deleting` (compare-and-set), so a duplicate job for a target that already
 * finished does nothing. Deleting is idempotent, so a retry can never
 * duplicate anything — an unknown outcome is thrown back to BullMQ, and only
 * the FINAL attempt records it as failed.
 */

export interface PlatformDeleteDeps {
  prisma: any;
  deleteOnPlatform: (
    platform: PlatformDeletePlatform,
    tokens: { accessToken: string; refreshToken?: string },
    platformPostId: string
  ) => Promise<PlatformDeleteOutcome>;
  now?: () => Date;
}

export class PlatformDeleteRetryError extends Error {}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function runPlatformDelete(
  deps: PlatformDeleteDeps,
  postTargetId: string,
  opts: { finalAttempt: boolean }
): Promise<PlatformDeleteRecord["status"] | "skipped"> {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();

  const claimed = await updatePlatformDeleteRecord(
    prisma,
    postTargetId,
    { status: "deleting" },
    { onlyIfStatus: ["queued", "deleting"] }
  );
  if (claimed === 0) return "skipped";

  const finish = async (
    status: "deleted" | "not_found" | "failed",
    message: string | null,
    deletedAt?: Date
  ): Promise<PlatformDeleteRecord["status"]> => {
    await updatePlatformDeleteRecord(
      prisma,
      postTargetId,
      { status, message, finishedAt: now().toISOString() },
      deletedAt ? { deletedAt } : {}
    );
    return status;
  };

  const target = await prisma.postTarget.findUnique({
    where: { id: postTargetId },
    select: { id: true, status: true, publishedId: true, platformDeletedAt: true, metadata: true, channelId: true },
  });
  if (!target) return "skipped";
  if (target.platformDeletedAt) return finish("deleted", null);
  if (target.status !== "PUBLISHED" || !target.publishedId) {
    return finish("failed", "This channel's post isn't published, so there is nothing to delete.");
  }

  // A DIRECT channel read — it is what decrypts the stored token.
  const channel = await prisma.channel.findUnique({ where: { id: target.channelId } });
  if (!channel) return finish("failed", "The channel no longer exists.");
  if (!isPlatformDeletePlatform(channel.platform)) {
    return finish("failed", "Deleting from this platform isn't supported.");
  }
  const platform = channel.platform as PlatformDeletePlatform;
  const name = platform === "FACEBOOK" ? "Facebook" : "Instagram";
  if (channel.disconnectedAt || !channel.isActive) {
    return finish("failed", `This channel is ${channel.disconnectedAt ? "disconnected" : "paused"}. Reconnect it, then try again.`);
  }

  // An Instagram story whose media id was never identified only has its
  // container id stored, which cannot be deleted.
  const targetMeta = asObject(target.metadata);
  if (platform === "INSTAGRAM" && targetMeta?.storyMediaUnresolved === true) {
    return finish(
      "failed",
      "Instagram never reported this story's id, so it can't be deleted from here. Delete it in the Instagram app (stories disappear after 24 hours anyway)."
    );
  }

  const granted = asObject(channel.metadata)?.grantedScopes;
  const capability = platformDeleteCapability(platform, Array.isArray(granted) ? (granted as string[]) : null);
  if (capability.known && capability.canDelete === false) {
    return finish("failed", platformDeleteMissingScopeMessage(platform));
  }

  let outcome: PlatformDeleteOutcome;
  try {
    outcome = await deps.deleteOnPlatform(
      platform,
      { accessToken: channel.accessToken, refreshToken: channel.refreshToken ?? undefined },
      target.publishedId
    );
  } catch (err: any) {
    // The providers never throw; treat anything that does as unknown.
    console.error(`[PlatformDelete] ${name} delete threw for ${postTargetId}:`, err?.message ?? err);
    outcome = { kind: "retry", message: "The platform didn't confirm the delete. Check the post on the platform, then try again if it is still there." };
  }

  switch (outcome.kind) {
    case "deleted":
      return finish("deleted", null, now());
    case "not_found":
      return finish("not_found", outcome.message);
    case "refused":
      return finish("failed", outcome.message);
    case "retry":
      if (opts.finalAttempt) return finish("failed", outcome.message);
      throw new PlatformDeleteRetryError(outcome.message);
  }
}
