/**
 * Builds the AnalyticsSnapshot.metadata JSON from a provider's SocialAnalytics
 * result + the at-age checkpoint context. Merges the honesty metadata
 * (saved / reachIsDistinct / likeKind / metricsAvailable / source) that the
 * providers now return with the windowTag/capturedLate the sync worker owns.
 *
 * Returns `undefined` (not an empty object) when there is nothing to store, so
 * the snapshot-create stays byte-identical to the legacy no-metadata path.
 */
export interface SnapshotMetaInput {
  saved?: number;
  reachIsDistinct?: boolean;
  likeKind?: string;
  metricsAvailable?: Record<string, boolean>;
  source?: string;
}

export function buildSnapshotMetadata(
  a: SnapshotMetaInput,
  windowTag: string | undefined,
  capturedLate: boolean
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (a.saved != null) extra.saved = a.saved;
  if (a.reachIsDistinct != null) extra.reachIsDistinct = a.reachIsDistinct;
  if (a.likeKind != null) extra.likeKind = a.likeKind;
  if (a.metricsAvailable != null) extra.metricsAvailable = a.metricsAvailable;
  if (a.source != null) extra.source = a.source;
  if (windowTag) extra.windowTag = windowTag;
  if (capturedLate) extra.capturedLate = true;
  return Object.keys(extra).length > 0 ? extra : undefined;
}
