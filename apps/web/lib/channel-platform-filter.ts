/**
 * Platform filtering for channel pickers.
 *
 * ONE definition shared by Content Studio → Compose ("Select Channels") and the
 * Channel Groups cards, so a pill labelled "INSTAGRAM" means exactly the same
 * set of channels in both places. Keeping this pure (no React, no tRPC) means
 * the select-all arithmetic is unit-testable without a DOM — the filtered list
 * is what select-all acts on, so a bug here would silently select the wrong
 * channels and publish to them.
 */

/** Minimum shape both callers already have from `channel.list`. */
export type PlatformFilterable = { id: string; platform: string };

/**
 * Ordered platform facets for the pill row: most-populated platform first, then
 * alphabetical for a stable tie-break. Stability matters — pills must not
 * reorder between renders (a moving target is a mis-click), and `channel.list`
 * has no guaranteed platform ordering.
 */
export function platformCounts<T extends PlatformFilterable>(
  channels: T[] | undefined | null
): { platform: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const channel of channels ?? []) {
    if (!channel?.platform) continue;
    counts.set(channel.platform, (counts.get(channel.platform) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.platform.localeCompare(b.platform)));
}

/**
 * `platform === null` means "All" — returns a shallow COPY of the full list (not
 * the same reference; callers consume this synchronously in render, so do not
 * rely on identity here or use it as a hook dependency).
 * An unknown platform yields an empty list rather than falling back to "all":
 * showing everything under a filter the user explicitly picked would invite a
 * select-all over channels they never intended to target.
 */
export function filterByPlatform<T extends PlatformFilterable>(
  channels: T[] | undefined | null,
  platform: string | null
): T[] {
  const list = channels ?? [];
  if (platform === null) return [...list];
  return list.filter((channel) => channel.platform === platform);
}

/**
 * Splits a batch of channel ids into chunks no larger than the server's
 * per-call cap.
 *
 * This exists because an unchunked bulk call is a REGRESSION THIS REPO HAS
 * ALREADY SHIPPED ONCE: channel bulk-delete sent the full selection to a
 * procedure capped at 100 and failed the whole action with "Array must contain
 * at most 100 element(s)" — on an account that had accrued 110+ channels. Group
 * select-all faces the same shape (one org holds 387 Facebook Pages), so the
 * chunking is kept here, pure and tested, rather than inline in the component.
 */
export function chunkIds(ids: string[], size: number): string[][] {
  if (size < 1) throw new Error("chunkIds: size must be >= 1");
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Select-all arithmetic for a channel picker.
 *
 * `visibleIds` is what the user can currently see (platform filter + search
 * text already applied) — select-all must never reach past the filter, or a
 * user filtered to Instagram would silently publish to Facebook too.
 *
 * `allSelected` drives the button's add/remove mode. It is FALSE for an empty
 * visible list so the button can be disabled rather than becoming a no-op
 * "Deselect all (0)".
 */
export function computeSelectAll(
  visibleIds: string[],
  selectedIds: string[]
): { allSelected: boolean; selectedVisibleCount: number; next: string[] } {
  const selected = new Set(selectedIds);
  const visible = [...new Set(visibleIds)];
  const selectedVisibleCount = visible.filter((id) => selected.has(id)).length;
  const allSelected = visible.length > 0 && selectedVisibleCount === visible.length;

  if (allSelected) {
    // Deselect only the VISIBLE ids — selections made under another filter are
    // preserved, which is what makes filter-then-select-all composable.
    const visibleSet = new Set(visible);
    return { allSelected, selectedVisibleCount, next: selectedIds.filter((id) => !visibleSet.has(id)) };
  }
  return {
    allSelected,
    selectedVisibleCount,
    next: [...new Set([...selectedIds, ...visible])],
  };
}
