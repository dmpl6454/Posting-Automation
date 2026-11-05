/**
 * "Delete from Facebook / Instagram" — display rules (2026-11-05). Pure so the
 * wording and which targets are offered the action are unit-tested.
 *
 * The request state lives on PostTarget.metadata.platformDelete (written by the
 * worker); a target that WAS deleted also has platformDeletedAt. A small
 * reader is replicated here because the browser cannot import the queue
 * package (it opens a Redis connection).
 */

export type DeleteStatus = "queued" | "deleting" | "deleted" | "not_found" | "failed";

export type TargetDeleteState =
  /** Not a published Facebook/Instagram post — nothing to delete. */
  | { kind: "none" }
  | { kind: "eligible" }
  | { kind: "in_progress" }
  | { kind: "deleted"; at: string | null }
  | { kind: "not_found"; message: string }
  | { kind: "failed"; message: string };

const DELETABLE = new Set(["FACEBOOK", "INSTAGRAM"]);
/** Mirrors PLATFORM_DELETE_STALE_MS: a request this old is treated as lost. */
const STALE_MS = 30 * 60_000;

export interface DeleteViewTarget {
  status: string;
  publishedId?: string | null;
  platformDeletedAt?: string | Date | null;
  metadata?: unknown;
  channel: { platform: string };
}

export function platformName(platform: string): string {
  return platform === "FACEBOOK" ? "Facebook" : platform === "INSTAGRAM" ? "Instagram" : platform;
}

function record(metadata: unknown): { status?: string; message?: string; requestedAt?: string; finishedAt?: string } | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const r = (metadata as Record<string, unknown>).platformDelete;
  return r && typeof r === "object" && !Array.isArray(r) ? (r as any) : null;
}

export function targetDeleteState(t: DeleteViewTarget, now: Date = new Date()): TargetDeleteState {
  if (t.platformDeletedAt) {
    const at = record(t.metadata)?.finishedAt;
    return { kind: "deleted", at: typeof at === "string" ? at : new Date(t.platformDeletedAt).toISOString() };
  }
  if (!DELETABLE.has(t.channel.platform) || t.status !== "PUBLISHED" || !t.publishedId) return { kind: "none" };
  const rec = record(t.metadata);
  if (rec?.status === "queued" || rec?.status === "deleting") {
    const at = Date.parse(String(rec.requestedAt ?? ""));
    if (Number.isFinite(at) && now.getTime() - at < STALE_MS) return { kind: "in_progress" };
    return { kind: "eligible" };
  }
  if (rec?.status === "not_found") return { kind: "not_found", message: String(rec.message ?? "") };
  if (rec?.status === "failed") return { kind: "failed", message: String(rec.message ?? "") };
  return { kind: "eligible" };
}

/** Can the user ask (again) to delete this target? */
export function canRequestDelete(state: TargetDeleteState): boolean {
  return state.kind === "eligible" || state.kind === "failed" || state.kind === "not_found";
}

export interface PostDeleteSummary {
  requestable: number;
  inProgress: number;
  deleted: number;
  /** "Facebook", "Instagram" or "Facebook/Instagram" — the platforms that can be deleted. */
  platformsLabel: string;
}

export function postDeleteSummary(targets: DeleteViewTarget[], now: Date = new Date()): PostDeleteSummary {
  let requestable = 0;
  let inProgress = 0;
  let deleted = 0;
  const platforms = new Set<string>();
  for (const t of targets) {
    const s = targetDeleteState(t, now);
    if (canRequestDelete(s)) {
      requestable++;
      platforms.add(t.channel.platform);
    } else if (s.kind === "in_progress") inProgress++;
    else if (s.kind === "deleted") deleted++;
  }
  const names = ["FACEBOOK", "INSTAGRAM"].filter((p) => platforms.has(p)).map(platformName);
  return { requestable, inProgress, deleted, platformsLabel: names.length ? names.join("/") : "Facebook/Instagram" };
}

/** One line shown under a channel row, or null. */
export function targetDeleteLine(
  state: TargetDeleteState,
  platform: string
): { text: string; tone: "muted" | "ok" | "warn" | "error" } | null {
  const name = platformName(platform);
  switch (state.kind) {
    case "in_progress":
      return { text: `Deleting from ${name}…`, tone: "muted" };
    case "deleted":
      return {
        text: `Deleted from ${name}${state.at ? ` on ${new Date(state.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}. Its history stays here.`,
        tone: "ok",
      };
    case "not_found":
      return { text: state.message || `${name} couldn't find this post. It may already be deleted.`, tone: "warn" };
    case "failed":
      return { text: `Couldn't delete from ${name}: ${state.message || "unknown error"}`, tone: "error" };
    default:
      return null;
  }
}

export interface DeleteRequestSummary {
  queued: number;
  notPublished: number;
  unsupported: number;
  alreadyDeleted: number;
  inProgress: number;
  overLimit: number;
}

/** Toast text for the answer to a delete request. */
export function deleteRequestToast(s: DeleteRequestSummary): { title: string; description: string } {
  const notes: string[] = [];
  if (s.inProgress) notes.push(`${s.inProgress} already being deleted`);
  if (s.alreadyDeleted) notes.push(`${s.alreadyDeleted} already deleted`);
  if (s.unsupported) notes.push(`${s.unsupported} on platforms we can't delete from (only Facebook and Instagram)`);
  if (s.notPublished) notes.push(`${s.notPublished} never published`);
  if (s.overLimit) notes.push(`${s.overLimit} left over the 1,000-per-request limit; run it again to continue`);
  const tail = notes.length ? ` Skipped: ${notes.join("; ")}.` : "";
  if (s.queued === 0) {
    return { title: "Nothing to delete", description: `No published Facebook or Instagram posts to delete.${tail}` };
  }
  return {
    title: `Deleting ${s.queued} post${s.queued === 1 ? "" : "s"} from the platforms`,
    description: `This runs in the background, a little over a second per channel; each channel shows its result.${tail}`,
  };
}
