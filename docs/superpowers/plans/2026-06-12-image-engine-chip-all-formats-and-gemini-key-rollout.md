# Plan — "Image created by X" chip on ALL formats + new Gemini key rollout

**Date:** 2026-06-12
**Author:** RCA + plan by Claude (Fable); implementation per plan
**Scope:** Two independent workstreams. (1) Extend the layman-visible "Image created by X" chip from the static result card to **carousel, reel, and regenerate** so every format shows which AI made its images. (2) Roll the **new Google Gemini API key** into production safely.

---

## Workstream 1 — Image-engine chip on all formats

### Current state (shipped `bc898e8`)
- **Static** result card shows a separate UI chip (never baked into pixels): *"Image created by Google Gemini (Nano Banana)"* / *"…by OpenAI (GPT Image)"*, driven by `bgSource` + `imageEngine` in the mutation result.
- Backend plumbing already exists end-to-end for static: `generateImageSafe().source` → `renderStaticCreative` returns `imageEngine: "gemini" | "openai"` ([repurpose.router.ts:433](../../../packages/api/src/routers/repurpose.router.ts) return type, set at ~L466) → `buildHeadlineCreative` passes it through (~L1003 return type) → `renderedImageEngine` (~L1179) → mutation result `imageEngine` (~L1986).
- **Gap:** carousel + reel render slides through the SAME `buildHeadlineCreative`, but the per-slide `imageEngine` is **discarded**; `regenerateImage` doesn't return it either.

### Design decision — aggregation for multi-image formats
A carousel/reel has N slides that can mix engines (e.g. slide 1 by Gemini, slide 2 fell back to OpenAI; CTA slides skip AI entirely → no engine). UI shows **one aggregated chip**, not per-slide chips (layman-friendly, no swipe-coupled state):
- All AI slides same engine → *"Images created by Google Gemini (Nano Banana)"*
- Mixed → *"Images created by Google Gemini + OpenAI"*
- No AI slides (all fell back to article photo/gradient) → no chip; the card description already says *"Made from the article's photo (AI image was unavailable)"*.

### (A) Backend — `packages/api/src/routers/repurpose.router.ts`

1. **Per-slide engine capture (carousel + reel share this loop).** The slide-render worker returns at **~L1823**:
   ```ts
   return { slideIdx, imageBase64: creative.imageBase64, mimeType: creative.mimeType };
   ```
   → add `imageEngine: creative.imageEngine` (and `bgSource: creative.bgSource`). Collection at **~L1833** (`slideImages[result.slideIdx] = …`) stays positional; ALSO push into a mutation-scoped accumulator:
   ```ts
   // alongside renderedImageEngine (~L1179)
   const renderedEngines = new Set<"gemini" | "openai">();
   // in the collection loop:
   if (result.imageEngine) renderedEngines.add(result.imageEngine);
   ```
2. **Mutation result field.** Extend the final return (~L1986) with a **plural** field, keeping the singular for back-compat:
   ```ts
   imageEngine: renderedImageEngine ?? null,            // static (existing)
   imageEngines: [...renderedEngines],                  // carousel/reel (new; [] when none)
   ```
   For static, also push its single engine into `renderedEngines` so `imageEngines` is uniformly populated for every format (UI can prefer the array everywhere).
3. **Reel nuance.** The reel branch returns `videoPending: true` (~L1941) BEFORE the video exists, but its slides are rendered in-mutation — so `imageEngines` is already known and returned. **No SSE change needed.** (The chip labels the *slide images*; the stitched MP4 is ffmpeg, not an AI model.)
4. **`regenerateImage` mutation.** Its return (~L2167) is `{ url, mediaId }` → add `bgSource` + `imageEngine` from the `renderStaticCreative` result it already holds (`creative.bgSource` / `creative.imageEngine`). This lets the UI update the chip after a single-image regenerate instead of showing a stale engine.

### (B) Frontend — `apps/web/components/content-agent/RepurposeTab.tsx`

1. **Extract the chip** (currently inline at the static branch, ~L1313-1322) into a tiny local component so it isn't triplicated:
   ```tsx
   function ImageEngineChip({ engines, label = "Image created by" }: { engines: string[]; label?: string }) {
     if (!engines.length) return null;
     const names = engines.map((e) => (e === "openai" ? "OpenAI (GPT Image)" : "Google Gemini (Nano Banana)"));
     return (
       <div className="mt-1.5 inline-flex w-fit items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
         <Sparkles className="h-3 w-3 text-purple-500" />
         {label} {names.join(" + ")}
       </div>
     );
   }
   ```
2. **Static card:** replace the inline chip with `<ImageEngineChip engines={(results as any).imageEngines ?? []} />` (falls back to `[imageEngine]` if array absent for old in-flight results).
3. **Carousel card** (description currently *"Swipe through carousel slides"*): add `<ImageEngineChip engines={…} label="Images created by" />` under the `CardDescription`. Also make the carousel description honest like static: if `imageEngines.length === 0`, say *"Slides use the article's photo / branded backgrounds (AI image was unavailable)"*.
4. **Reel card:** chip with `label="Slide images created by"` — accurate, since the video itself is stitched, not AI-generated. Place under the reel description (*"AI-generated video with slides"*).
5. **Regenerate flow:** the regenerate handler that swaps the image URL should also update chip state from the new `imageEngine`/`bgSource` in the `regenerateImage` response (track a small `results`-patch or local state override).
6. **Seedance/Veo3 cards:** descriptions already name the video model ("by Seedance 2.0" / "by Veo3") — no chip needed (optional cosmetic only; skip).

### (C) Tests
1. **`repurpose-image-engines.test.ts` (new):** mock `generateImageSafe` so slide 1 returns `source:"gemini"`, slide 2 `source:"dalle"`, CTA skipped → assert mutation result `imageEngines` equals `["gemini","openai"]`; all-fail case → `[]` + `bgSource` fallback behavior unchanged.
2. **`repurpose-regenerate.test.ts`:** add assertion that the response now includes `imageEngine` (mock source `"dalle"` → `"openai"`).
3. Keep green: all existing repurpose suites (static `bgSource`/`imageEngine` behavior unchanged), security suites untouched.
4. `pnpm --filter @postautomation/api test` + `pnpm --filter @postautomation/web exec tsc --noEmit`.

### Guardrails (no-sabotage)
- Do NOT alter the image fallback chain, sanitizers, SSRF guards, or the render pipeline — this is read-only threading of an existing field plus UI.
- `slideImages` positional collection must stay intact (slide order = publish order).
- The chip is UI-only; never draw on the image.

---

## Workstream 2 — New Gemini key rollout (`AQ.Ab8RN6…`)

### Verified state of the new key (live curl, 2026-06-12)
| Capability | Result | Meaning |
|---|---|---|
| Text (`gemini-2.5-flash`) | ✅ **works** ("ok" returned) | Key has free-tier TEXT quota — strictly better than the old key (which was `limit: 0` for everything) |
| Image (`gemini-2.5-flash-image` / Nano Banana) | ❌ 429 quota | **Billing still NOT attached** to the key's project — free tier has no image-model quota |

**Honest implication:** swapping this key in unlocks **real Gemini + Gemma 4 text in prod** (the dropdown picks actually serve Gemini instead of silently falling back). It does **NOT** unlock Nano Banana images or Veo3 — that requires either (a) "Set up billing" on THIS key's project in AI Studio (then the same key gains paid quota — zero further code/env change), or (b) the OpenAI credit top-up (images then come via the gpt-image-1 fallback). Both can be done independently; the key swap is worth doing now regardless.

### Rollout steps (operator + assistant)
1. **Prod env update** (server `/home/deploy/postautomation`):
   - Edit `.env.prod` (NOT `.env.production` — that's the symlink; CLAUDE.md quirk #1): set
     `GOOGLE_GEMINI_API_KEY="AQ.Ab8RN6…"` ← full key supplied by the operator out-of-band; **never write the full key into this repo, any committed file, or CI logs**
   - This is the only var name needed (`.env.example:49`); `GOOGLE_AI_API_KEY` is just the code-level alternate and is unset.
2. **Recreate containers** (env change needs recreate, not rebuild):
   `docker compose -f docker-compose.prod.yml --env-file .env.production up -d web worker`
   (Both web AND worker read the key — worker runs autopilot/news image jobs.)
3. **Local parity:** update `GOOGLE_GEMINI_API_KEY` in the local `.env` too.
4. **Verify:**
   - `docker exec postautomation-web-1 printenv GOOGLE_GEMINI_API_KEY | cut -c1-6` → `AQ.Ab8`
   - Run a Repurpose with provider = "Google (Gemini)" → captions generate **without** a fallback hop (server logs show no `[Repurpose] … failed, trying next provider` warn for gemini), Super Agent badge shows "Google (Gemini)" when routed there.
   - Image path: still expect the article-photo fallback until billing/OpenAI — the new chip should show *"AI image was unavailable"* until then. NOT a regression; expected.
5. **Decommission the old key** (`AIzaSyBX19…`): delete it in the Google console after the swap is verified (it is zero-quota dead weight and has appeared in terminals/logs).
6. **🔒 Security hygiene (required):**
   - The new key was pasted into chat — treat it as semi-exposed. After rollout is stable, **restrict the key** in console (API restriction: Generative Language API only) and plan a rotation once billing is set up.
   - **NEVER commit it to git** — it lives only in `.env.prod` / local `.env` (both gitignored). Do not echo the full key into CI logs; use `cut -c1-6` style checks.
7. **Free-tier caveat (set expectations):** free-tier text has low rate limits (per-minute + per-day caps). Fine for current low traffic; for real multi-user volume, complete "Set up billing" on the key's project — which ALSO unlocks Nano Banana + Veo3 with no further changes.

### What this does NOT do
- Does not fix AI **images** (needs billing on this project OR OpenAI credits — §2 verified state).
- Does not touch Veo3 (stays disabled in the UI until the same billing).
- No code changes at all — pure env/ops; the resilient chains shipped earlier mean even a misstep degrades gracefully rather than breaking flows.

---

## Suggested execution order
1. **Workstream 2 first** (15 min, ops-only): key swap + verify → prod immediately gains real Gemini/Gemma text.
2. **Workstream 1** (one focused PR): backend threading → frontend chip → tests → deploy.
3. **Operator, separately:** OpenAI "Add credits" (one click → images work via fallback, chip starts saying "created by OpenAI (GPT Image)"), and optionally Google "Set up billing" on the new key's project (→ chip flips to "created by Google Gemini (Nano Banana)", Veo3 unlockable).
