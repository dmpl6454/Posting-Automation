import type { SuperTextConfig } from "@postautomation/super-text";
import {
  SUPER_TEXT_VARIANT_CHUNK,
  assignVariantIndexes,
  baseTextOf,
  buildSuperTextVariantPrompt,
  maxSuperTextVariants,
  parseVariantArray,
  sanitizeVariantTexts,
  variantCharLimit,
  variantConfigFromBase,
  variantsToGenerate,
} from "./super-text-variants";

/**
 * Per-channel super text — the orchestration, with every side effect injected
 * (`generateText`, `burn`, `writeTargetMedia`, `persist`) so the whole state
 * machine runs in a unit test without a model, ffmpeg, S3 or Postgres.
 *
 * Order of operations, and why:
 *   1. generate ALL variant lines first and PERSIST them — a BullMQ retry must
 *      burn the same words it started with, not ask the model again;
 *   2. burn each variant, persisting per variant — a crash mid-loop never
 *      re-encodes finished work (the derived Media row is already real);
 *   3. assign targets round-robin and write each target's own derived id.
 *
 * Degradation, never loss: a variant that fails to generate or burn leaves its
 * targets on the SHARED burn (the user's own text — still super text, just not
 * unique). The caller decides how to surface `degraded`.
 */

export interface PerChannelTarget {
  id: string;
  channel: { name: string | null; username: string | null; platform: string };
}

export interface PerChannelVariantResult {
  status: "done" | "failed";
  text: string;
  derivedMediaId?: string;
}

/** Persisted under post.metadata.superText.perChannelState[sourceMediaId]. */
export interface PerChannelState {
  /** Variant lines in burn order (index k ⇒ variant k+1). Set once, before any burn. */
  texts?: string[];
  /** Keyed by the 1-based variant index, as a string (JSON-friendly). */
  variants?: Record<string, PerChannelVariantResult>;
  /** The model produced NO usable line at all. */
  generationFailed?: boolean;
  /** Generation stopped early because every provider is out of credit. */
  outOfCredit?: boolean;
}

export interface PerChannelDeps {
  /** The post's DRAFT/SCHEDULED targets in a STABLE order. */
  loadTargets: () => Promise<PerChannelTarget[]>;
  /** Provider-chain-wrapped text generation: prompt in, raw model text out. */
  generateText: (prompt: string) => Promise<string>;
  /** Burn ONE variant config into the source video; returns the derived Media id. */
  burn: (cfg: SuperTextConfig, variantIndex: number) => Promise<{ derivedMediaId: string }>;
  /** Record a target's own burned copy (idempotent merge into target metadata). */
  writeTargetMedia: (
    targetId: string,
    entry: { mediaId: string; text: string; variant: number }
  ) => Promise<void>;
  /** Persist the running state (post metadata) — called after every step. */
  persist: (state: PerChannelState) => Promise<void>;
  isCreditExhausted?: (err: unknown) => boolean;
  maxVariants?: number;
  chunkSize?: number;
  log?: (msg: string) => void;
}

export interface PerChannelOutcome {
  targets: number;
  /** Variants burned in THIS run (retries skip finished ones). */
  burned: number;
  /** Targets publishing an AI variant. */
  unique: number;
  /** Targets publishing the user's own line (variant 0). */
  onBase: number;
  /** Targets that WANTED a variant but got the shared burn (generation/burn failure). */
  fallback: number;
  degraded: boolean;
  state: PerChannelState;
}

export async function runPerChannelSuperText(
  deps: PerChannelDeps,
  input: {
    sourceMediaId: string;
    baseCfg: SuperTextConfig;
    postContent: string;
    state: PerChannelState | undefined;
  }
): Promise<PerChannelOutcome> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const state: PerChannelState = { ...(input.state ?? {}) };
  const targets = await deps.loadTargets();
  const base = { targets: targets.length, burned: 0, unique: 0, onBase: 0, fallback: 0 };
  if (targets.length <= 1) {
    return { ...base, onBase: targets.length, degraded: false, state };
  }

  const cap = deps.maxVariants ?? maxSuperTextVariants();
  const want = variantsToGenerate(targets.length, cap);
  const baseText = baseTextOf(input.baseCfg);
  const charLimit = variantCharLimit(baseText);
  let degraded = false;

  // ── 1. Variant lines (once) ──────────────────────────────────────────────
  if (!state.texts && !state.generationFailed) {
    const chunkSize = deps.chunkSize ?? SUPER_TEXT_VARIANT_CHUNK;
    // Variant k is written "for" target k (round-robin puts it there); the
    // prompt names that channel so the line can lean into its audience.
    const wanted = targets.slice(1, 1 + want);

    /** One pass over `channels` in chunks; returns the raw candidate lines. */
    const askModel = async (channels: PerChannelTarget[], avoid: string[], pass: number) => {
      const candidates: string[] = [];
      for (let i = 0; i < channels.length; i += chunkSize) {
        const chunk = channels.slice(i, i + chunkSize);
        try {
          const raw = await deps.generateText(
            buildSuperTextVariantPrompt({
              baseText,
              postContent: input.postContent,
              channels: chunk.map((t, j) => ({
                index: j,
                platform: t.channel.platform,
                channelName: t.channel.name || t.channel.platform,
                username: t.channel.username,
              })),
              charLimit,
              avoid,
            })
          );
          const parsed = parseVariantArray(raw);
          if (parsed.length === 0) {
            // The array parsed but held nothing usable — show what came back so
            // the next "all channels got the same text" report is diagnosable.
            log(
              `[super-text] model returned no usable items for ${input.sourceMediaId} (pass ${pass}, chunk at ${i}): ${JSON.stringify(raw.slice(0, 300))}`
            );
          }
          const byIndex = new Map(parsed.map((v) => [v.index, v.text]));
          for (let j = 0; j < chunk.length; j++) {
            const text = byIndex.get(j);
            if (text) candidates.push(text);
          }
        } catch (err: any) {
          log(
            `[super-text] variant generation failed for ${input.sourceMediaId} (pass ${pass}, chunk at ${i}): ${err?.message ?? err}`
          );
          if (deps.isCreditExhausted?.(err)) {
            state.outOfCredit = true;
            return candidates;
          }
        }
      }
      return candidates;
    };

    const firstPass = await askModel(wanted, [], 1);
    let texts = sanitizeVariantTexts({ baseText, candidates: firstPass, charLimit, baseCfg: input.baseCfg });

    // ── Second ask for the shortfall (2026-10-03) ──
    // A model that overshoots the length, repeats itself, or echoes the base
    // leaves fewer usable lines than channels. Before, that silently became
    // "several channels publish the user's line" — indistinguishable, to the
    // user, from the feature not working. One more ask, for just the missing
    // count, naming the lines already taken. Never after an out-of-credit
    // signal, and never a third time.
    if (texts.length < want && !state.outOfCredit) {
      const missing = wanted.slice(texts.length);
      log(
        `[super-text] ${input.sourceMediaId}: ${texts.length} usable of ${want} wanted after pass 1 (${firstPass.length} returned) — asking once more for ${missing.length}`
      );
      const secondPass = await askModel(missing, texts, 2);
      texts = sanitizeVariantTexts({
        baseText,
        candidates: [...texts, ...secondPass],
        charLimit,
        baseCfg: input.baseCfg,
      });
    }

    if (texts.length === 0) {
      state.generationFailed = true;
      log(
        `[super-text] ${input.sourceMediaId}: NO usable variant line after two asks (${firstPass.length} raw candidates, limit ${charLimit} chars${state.outOfCredit ? ", provider out of credit" : ""}) — every channel keeps the user's own line`
      );
    } else {
      state.texts = texts;
    }
    await deps.persist(state);
  }

  const texts = state.texts ?? [];
  const variants: Record<string, PerChannelVariantResult> = { ...(state.variants ?? {}) };
  state.variants = variants;

  // ── 2. Burn each variant once ────────────────────────────────────────────
  let burned = 0;
  for (let k = 1; k <= texts.length; k++) {
    const key = String(k);
    const text = texts[k - 1]!;
    const prior = variants[key];
    if (prior?.status === "done" && prior.derivedMediaId) continue;
    if (prior?.status === "failed") continue; // tried in an earlier attempt — do not loop forever
    const cfg = variantConfigFromBase(input.baseCfg, text);
    if (!cfg) {
      variants[key] = { status: "failed", text };
      await deps.persist(state);
      continue;
    }
    try {
      const { derivedMediaId } = await deps.burn(cfg, k);
      variants[key] = { status: "done", text, derivedMediaId };
      burned++;
    } catch (err: any) {
      log(`[super-text] variant ${k} burn failed for ${input.sourceMediaId}: ${err?.message ?? err}`);
      variants[key] = { status: "failed", text };
    }
    await deps.persist(state);
  }

  // ── 3. Assign targets ────────────────────────────────────────────────────
  // ACTUAL assignment uses the lines we have; INTENDED uses the lines we asked
  // for. A target that was meant to get a variant and ends on the shared burn
  // (too few usable lines, or a failed burn) is a FALLBACK, not "on base".
  const actual = assignVariantIndexes(targets.length, texts.length);
  const intended = assignVariantIndexes(targets.length, want);
  let unique = 0;
  let onBase = 0;
  let fallback = 0;
  for (let i = 0; i < targets.length; i++) {
    const k = actual[i]!;
    const v = k > 0 ? variants[String(k)] : undefined;
    if (v?.status === "done" && v.derivedMediaId) {
      await deps.writeTargetMedia(targets[i]!.id, { mediaId: v.derivedMediaId, text: v.text, variant: k });
      unique++;
    } else if (intended[i] === 0) {
      onBase++;
    } else {
      fallback++;
    }
  }
  if (state.generationFailed || fallback > 0 || Object.values(variants).some((v) => v.status === "failed")) {
    degraded = true;
  }
  // Fewer lines than targets wanted (model returned too few / duplicates) is
  // still "every target got a strip", but not the uniqueness asked for.
  if (texts.length < want) degraded = true;

  return { targets: targets.length, burned, unique, onBase, fallback, degraded, state };
}
