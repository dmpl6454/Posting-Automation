import { superTextConfigSchema, type SuperTextConfig } from "@postautomation/super-text";

/**
 * Build the `metadata.superText` map (mediaId → config) that post.create expects,
 * from Compose's postMedia list and the ids resolvePostMediaIds returned.
 *
 * INDEX ALIGNMENT: resolvePostMediaIds pushes exactly one id per postMedia item —
 * in order — or throws before returning, so `mediaIds[i]` belongs to
 * `postMedia[i]`. If that ever stops being true this helper is the place to fix
 * it; misalignment would burn a strip onto the WRONG video.
 *
 * Every config is re-validated: a draft restored from localStorage (possibly
 * written by an older build, or hand-edited) must never make post.create reject
 * the entire post. An invalid entry is dropped, not fatal.
 *
 * Returns an empty object when nothing has super text — the caller then omits the
 * key entirely, so an ordinary post's payload is byte-identical to before.
 */
export function buildSuperTextPayload(
  postMedia: Array<{ superText?: SuperTextConfig }>,
  mediaIds: string[]
): Record<string, SuperTextConfig> {
  const out: Record<string, SuperTextConfig> = {};
  postMedia.forEach((item, i) => {
    const id = mediaIds[i];
    if (!item?.superText || !id) return;
    const parsed = superTextConfigSchema.safeParse(item.superText);
    if (parsed.success) out[id] = parsed.data;
  });
  return out;
}
