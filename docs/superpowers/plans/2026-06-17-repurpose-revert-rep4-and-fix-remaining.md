# Repurpose: Revert REP-4 (free-drag) + Fix Remaining Issues — Implementation Plan & Handoff

> **For the next session:** REQUIRED SUB-SKILL: use `superpowers:systematic-debugging` (already done — root causes below are verified) then `superpowers:test-driven-development` + `superpowers:subagent-driven-development` to implement. Verify with the golden gate after every step.

**Date:** 2026-06-17
**Author:** Claude (Opus) — root-caused via a 5-agent investigation workflow, each finding traced to file:line.
**Status:** Plan ready. NOT yet implemented. The working tree may contain a scratch revert from the revert-scope probe — **the implementer must reset and start clean** (see Step 0).

**Context:** REP-4 (Canva-like free-drag positioning, PRs merged as commits `9eb88be` renderer + `d581f15` router/UI) shipped a broken result. The user (livelihood depends on Repurpose) wants the free-drag REMOVED, logo + hook restored to pre-REP-4 behavior, and **all** remaining Repurpose issues fixed. REP-2 (per-slide carousel text, #84) and REP-3 (postcard grid, #85) are GOOD — keep them.

---

## ⚠️ The key insight (do not skip)

There are **TWO INDEPENDENT problem classes**. Reverting REP-4 fixes the first but NOT the second:

1. **REP-4-introduced (revert fixes):** two logos + raw `**markup**` hook chip — both are the REP-4 drag-overlay DOM layer drawing duplicate/distorted chips over the already-correct baked PNG.
2. **PRE-EXISTING (revert does NOT fix — needs its own targeted fix):**
   - **Empty white box in the PNG** — `buildHookBars` renders the headline `.bar` (white pill) unconditionally even when the headline is empty.
   - **"Not in draft" + "Instagram requires an image; none attached"** — when the static render FAILS, the router swallows the error into a soft `mediaFailed=true`, hiding the preview AND producing a media-less draft that fails to publish.

**If you only revert REP-4, the user's publish failures CONTINUE.** Both phases below are required.

---

## Root causes (verified, file:line)

### R1 — Two logos (REP-4)
`apps/web/components/content-agent/RepurposeTab.tsx:2211-2239` renders a second draggable logo chip (36×36 `rounded-full border-2 border-white bg-white/80`) over `results.mediaUrls[0]` — but the PNG ALREADY bakes the logo via `logoHtml()` ([creative-templates.ts:170-178](packages/ai/src/tools/creative-templates.ts#L170)) positioned by `logoCssBody` (`:99-107`). Two different renderings of the same logo. **Revert removes the chip.**

### R2 — Hook chip shows raw `**word**` (REP-4)
`RepurposeTab.tsx:2262` renders `results.hookLine.slice(0,40)` directly — never through `renderHighlightMarkup`. `results.hookLine` is the raw AI output (`repurpose.router.ts:2014`), and `buildHookLinePrompt` (`:337`) tells the model to wrap words in `**double asterisks**`. The PNG converts them to accent spans (`creative-templates.ts:241`), the chip does not. **Revert removes the chip.**

### R3 — Empty white box in the PNG (PRE-EXISTING, since the original 4-style renderer)
`packages/ai/src/tools/creative-templates.ts:263` (`buildHookBars`): the headline `.bar` is emitted UNCONDITIONALLY: `<div class="bar"><div class="headline">${escapeHtml(opts.headline)}</div></div>` with `.bar{background:#fff;...}` (`:253`). When `opts.headline` is empty/whitespace → white pill, no text. The hook bar above it IS guarded (`hookHtml ? ... : ""`, `:262`); the headline bar is NOT. (The named layout-extract mimicry path in `card-engine.ts:569` already has the Round-19 empty-pill guard — only `buildHookBars` lacks it.) **Revert does NOT touch this.**

### R4 — Render-fail → media-less draft + hidden preview (PRE-EXISTING)
Media wiring is CORRECT and unchanged by REP-4: both the mimicry and template static branches call `uploadAndCreateMedia` (`repurpose.router.ts:2251`) → `prisma.media.create` (`:1668`) → `perPlatformMedia[platform] = {url, mediaId}` (`:2259-2261`) → returned as `mediaMap` (`:3027`). Create Drafts collects `carouselMediaIds` first, else iterates `mediaMap` (`RepurposeTab.tsx:2987-2999`). So `mediaMap` is empty ONLY when the static render FAILED — and the try/catch at `repurpose.router.ts:2274-2280` **swallows the error**, leaving `mediaUrls=[]` → `mediaFailed=true` (`:3005`). Effects: (a) preview Card gated by `results.mediaUrls.length>0` (`RepurposeTab.tsx:2100`) hides → "not in draft"; (b) zero media attached → worker `publish-recovery.ts:125-128` emits the exact "Instagram requires an image…" message. **Revert does NOT touch this.** Likely trigger: the T3 no-photo guard at `router:2170` throwing, or a Puppeteer/template crash in `buildHeadlineCreative`.

---

## Implementation plan (phased, TDD, golden-gate-green)

### Step 0 — Clean slate
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation
git checkout main && git pull origin main
git status            # MUST be clean — if a scratch revert is staged, `git reset --hard HEAD` first
git checkout -b fix/repurpose-revert-rep4-and-remaining
pnpm --filter @postautomation/ai test repurpose-render-golden   # baseline: 17/17 green
```

### Phase A — Revert REP-4 (fixes R1 + R2)
1. `git revert --no-commit d581f15 9eb88be` (newer-first; verified conflict-free on current main).
2. Inspect: `git diff --staged --stat` should touch exactly: `apps/web/components/content-agent/RepurposeTab.tsx`, `packages/api/src/routers/repurpose.router.ts`, `packages/ai/src/tools/creative-templates.ts`, `packages/ai/src/__tests__/creative-templates.test.ts` (REP-4 test removed), and the golden test file IF REP-4 added cases there (it added to `creative-templates.test.ts`, not the golden snapshot — confirm the 17 golden snapshots are unaffected).
3. Confirm the static branch in `RepurposeTab.tsx` is back to the plain `<img src={results.mediaUrls[0]} className="w-full max-w-xs rounded-xl shadow-lg" />` (pre-REP-4), and `logoPosXY/hookPosXY/posDragRef` state + payload spreads are gone.
4. Verify: golden gate 17/17 (0 written); `pnpm --filter @postautomation/ai test`; `pnpm --filter @postautomation/api test`; `pnpm --filter @postautomation/api exec tsc --noEmit`; `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (exit 0).
5. Commit (one or two revert commits for attributable history): `git commit` (the revert messages are auto-generated; keep them).
   - **Confirm REP-2 + REP-3 intact:** `grep -n "carouselSlides" packages/api/src/routers/repurpose.router.ts` and `grep -n "postcard_grid" packages/ai/src/tools/creative-templates.ts` still present; postcard golden snapshots still in the snap file.

### Phase B — Fix R3 (empty headline pill) — TDD
1. **Failing test** in `packages/ai/src/__tests__/creative-templates.test.ts`: `buildStaticCreative({...hook_bars base, headline: ""})` → assert the output does NOT contain an empty `<div class="bar"><div class="headline"></div></div>` (no white pill when headline blank). Also a non-empty headline still renders the bar.
2. **Fix** `creative-templates.ts:263`: guard the headline bar like the hook bar — only emit `<div class="bar">…headline…</div>` when `opts.headline?.trim()` is non-empty. Mirror the `card-engine.ts:569` empty-pill guard. Do not emit an empty `.bars` container either.
3. **Golden gate:** the existing fixtures all pass a non-empty headline, so the 17 snapshots must stay byte-identical (0 written). If any changes, the guard altered a non-empty path — fix it.
4. Verify + commit.

### Phase C — Fix R4 (render-fail surfaces honestly, no media-less draft) — TDD
This is the **livelihood-critical** fix. Two layers (defense-in-depth):
1. **Backend (`repurpose.router.ts:2274-2280`)** — for the SYNCHRONOUS static path, stop swallowing the render error into a soft `mediaFailed`. Rethrow via `toFriendlyAIError` so the mutation returns a hard, actionable error (e.g. "Couldn't generate the image — no source photo and AI image generation is unavailable. Add a photo or try again."). Keep the soft path only where a partial result is genuinely useful (captions-only is debatable — prefer a hard error for a single static image the user expects to publish). **Test:** mock the render to throw → assert the mutation throws a friendly error (not a silent `mediaFailed` success). Investigate the actual trigger first (T3 no-photo guard at `:2170` vs Puppeteer crash) — add a one-time diagnostic log of the swallowed error if needed.
2. **Frontend guard (`RepurposeTab.tsx` Create Drafts `:2987-3008` + Create Post `:2942-2950`)** — if `mediaIds.length === 0` for an image format targeting IG/FB, BLOCK with a clear toast ("Image generation failed — regenerate before publishing") instead of creating a media-less draft. **Test:** (component-level or a pure helper extracted from the collector) zero media + IG target → blocked.
3. Verify (api test + web build) + commit.

### Phase D — Adversarial verification + close-out
1. Run a verification workflow (or manual): confirm (a) revert removed both chips and restored the plain img; (b) REP-2/REP-3 still work (carousel per-slide editor renders; postcard_grid renders); (c) hook_bars with empty headline → no white pill (golden + new test); (d) a forced render failure → hard friendly error + no media-less draft.
2. Full suites green; golden 17/17; web build exit 0.
3. Open PR. After merge + deploy, **manually re-test the exact failing flow** (the Moviefied reference → static mimicry) to confirm the empty box is gone, the result shows in the draft area, and Create Drafts attaches the image.

---

## Verification checklist (every phase)
- `pnpm --filter @postautomation/ai test repurpose-render-golden` → **17/17, 0 snapshots written** (byte-identical default renders — the don't-sabotage gate).
- `pnpm --filter @postautomation/ai test` + `pnpm --filter @postautomation/api test` → green.
- `pnpm --filter @postautomation/api exec tsc --noEmit` (bare) → clean.
- `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` → exit 0 (SWC catches syntax tsc accepts — non-negotiable for apps/web).
- Security suites green: `creative-templates.test.ts`, `image-fetch-ssrf.test.ts`, ownership/IDOR suites.

## Risks
- **R-A:** the scratch revert may already be staged in the working tree from the investigation — Step 0's `git reset --hard` is mandatory or the revert double-applies.
- **R-B:** Phase C must not over-tighten (don't hard-fail the captions when only the image failed if the user might still want captions) — but a static *image* post with no image IS a hard failure; prefer blocking publish over a silent media-less draft.
- **R-C:** confirm REP-2/REP-3 untouched by the revert (they landed after REP-4? NO — REP-4 is the newest; REP-2 #84 and REP-3 #85 are older, so the revert of the two newest commits leaves them intact — but verify with the greps in Phase A.5).
- **R-D:** the deployed version in the screenshots (v1.0.626/628) — confirm the fix is actually deployed after merge (GitHub Actions on push to main); the prior failed post was a stale media-less draft and won't self-heal — the user may need to delete + recreate it.

## Decision log
- **D1:** Revert REP-4 (not surgical removal) — `git revert` reproduces the exact pre-REP-4 state across 4 files conflict-free; surgery near adjacent REP-2/REP-3 spreads is riskier.
- **D2:** Keep REP-2 + REP-3 — they are good and independent; only REP-4's overlay broke things.
- **D3:** Fix R3 + R4 separately (they are pre-existing, NOT fixed by the revert). This is the part that actually restores publishing.
- **D4:** Leave the renderer-side `logoPosXY/hookPosXY` support reverted too (Phase A removes 9eb88be), so there's no dead code; the byte-identical golden gate confirms no regression.
