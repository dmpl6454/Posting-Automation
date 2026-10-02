/**
 * Per-target media substitution (2026-10-02) — the publish-worker half of
 * per-channel super text.
 *
 * A post's PostMedia rows are SHARED by every target. Per-channel super text
 * gives one target its OWN burned copy of a video, recorded on the target as
 *
 *   PostTarget.metadata.superTextMedia = {
 *     [sourceMediaId]: { mediaId: "<derived Media id>", text: "<strip line>" }
 *   }
 *
 * keyed by the ORIGINAL (source) media id. By publish time the shared attachment
 * may already point at the base burn's derived row (the super-text worker
 * repoints PostMedia), so the match goes through the derived row's own
 * `metadata.superText.sourceMediaId` back to the source id.
 *
 * Absent metadata ⇒ the attachments are returned UNTOUCHED (same array, same
 * objects), which is what keeps every existing publish path byte-identical.
 */

export const SUPER_TEXT_MEDIA_KEY = "superTextMedia";

type SuperTextMediaMap = Record<string, { mediaId?: unknown; text?: unknown }>;

function readMap(targetMetadata: unknown): SuperTextMediaMap | null {
  const map = (targetMetadata as Record<string, unknown> | null | undefined)?.[SUPER_TEXT_MEDIA_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  return map as SuperTextMediaMap;
}

/** Derived Media ids this target wants loaded. Empty for every pre-feature target. */
export function collectPerTargetMediaIds(targetMetadata: unknown): string[] {
  const map = readMap(targetMetadata);
  if (!map) return [];
  const ids = new Set<string>();
  for (const entry of Object.values(map)) {
    if (entry && typeof entry === "object" && typeof entry.mediaId === "string" && entry.mediaId) {
      ids.add(entry.mediaId);
    }
  }
  return [...ids];
}

/** The source id an attached Media row stands for (itself, unless it is a burn). */
export function sourceMediaIdOf(media: { id: string; metadata?: unknown }): string {
  const src = (media.metadata as { superText?: { sourceMediaId?: unknown } } | null | undefined)?.superText
    ?.sourceMediaId;
  return typeof src === "string" && src ? src : media.id;
}

/**
 * Swap in this target's own burned videos. `derivedRows` are the Media rows
 * already loaded (org-scoped by the caller); an id that did not load is simply
 * left as the shared attachment — a missing variant must degrade to the shared
 * burn, never fail the publish.
 */
export function substitutePerTargetMedia<A extends { mediaId: string; media: { id: string; metadata?: unknown } }>(
  attachments: A[],
  targetMetadata: unknown,
  derivedRows: A["media"][]
): A[] {
  const map = readMap(targetMetadata);
  if (!map) return attachments;
  const byId = new Map(derivedRows.map((r) => [r.id, r]));
  let changed = false;
  const out = attachments.map((a) => {
    const entry = map[sourceMediaIdOf(a.media)];
    const wantId = entry && typeof entry.mediaId === "string" ? entry.mediaId : null;
    if (!wantId || wantId === a.media.id) return a;
    const row = byId.get(wantId);
    if (!row) return a;
    changed = true;
    return { ...a, mediaId: row.id, media: row };
  });
  return changed ? out : attachments;
}
