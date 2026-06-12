# Fix Plan — Incomplete (mid-word) headline text on generated post images

**Date:** 2026-06-12
**Author:** RCA + plan by Claude (Opus); implementation by Sonnet
**Symptom:** AI-generated post images show headlines cut off mid-clause/mid-word:
- "West Asia war updates: Iran announces closure of Strait of Hormuz **after**"
- "Free FIFA World Cup 2026 streaming on Doordarshan in India? Here's **what**"
- "Free FIFA World Cup 2026 streaming in India? Here's what football **fans**"

The visuals (background photo, brand styling, logo) are excellent; the truncated headline ruins them.

---

## 1. Root cause (verified, not guessed)

### Primary cause — `capHeadline` is a hard word-count guillotine with no sentence awareness

[`capHeadline`](../../../packages/api/src/routers/repurpose.router.ts) (repurpose.router.ts:281-286):

```ts
export function capHeadline(text: string): string {
  const words = text.trim().split(/\s+/);
  let out = words.slice(0, 12).join(" ");      // ← keeps first 12 words, DISCARDS the rest
  if (out.length > 80) out = out.slice(0, 80).replace(/\s+\S*$/, "");
  return out.trim();
}
```

It keeps the first **12 words** (or 80 chars) and throws the rest away — **no regard for sentence/clause boundaries, no ellipsis**. A 16-word AI headline becomes 12 words ending mid-thought.

**Reproduced exactly** by running the real function on the screenshot headlines:

| AI headline (full) | words | capHeadline output |
|---|---|---|
| "West Asia war updates: Iran announces closure of Strait of Hormuz after US strikes nuclear sites" | 16 | "...Strait of Hormuz **after**" |
| "Free FIFA World Cup 2026 streaming on Doordarshan in India? Here's what you need to know" | 16 | "...India? Here's **what**" |
| "Free FIFA World Cup 2026 streaming in India? Here's what football fans should know" | 14 | "...football **fans**" |
| "Free FIFA World Cup 2026 streaming in India via Doordarshan: Key insights" | 12 | unchanged ✅ |

The one complete headline was *exactly 12 words* — it survived. Every truncated one was >12 words. This is conclusive.

### Contributing cause — the AI is never told to produce a COMPLETE headline within the cap

LLMs do not reliably honor "max N words". The generation prompts ask for "punchy" / "max 10–12 words" but **never instruct the model to return one complete, self-contained headline that fits**. So the model over-produces (14–16 words), and the guillotine then chops the overflow mid-clause. The prompts and the cap also disagree on the budget (some say 10 words, some 12), reinforcing the mismatch.

### Why the cap exists (and why it's stricter than it needs to be)

[`headlineFontSize`](../../../packages/ai/src/tools/creative-templates.ts) (creative-templates.ts:138) — the renderer **already** has font tiers for long headlines:

```ts
words <= 5 ? 82 : words <= 8 ? 66 : words <= 12 ? 54 : words <= 16 ? 46 : 40
```

The template was **designed to render 13–16-word headlines at 46px** and 17+ at 40px. The body block is bottom-anchored with `word-break:break-word`; the only failure mode is that beyond ~16 words the 40px floor + `overflow:hidden` canvas can clip lines out of frame. So:

- The cap is a **defensive input guard**, not a hard layout limit.
- The template comfortably handles **up to 16 words** — the cap is set 4 words too tight, AND it cuts dumbly.

### Blast radius (verified — important, narrows the fix)

`capHeadline` is called in exactly 3 places; the **published social-platform caption (`platformContent`) is NEVER truncated** (zero hits). The incomplete text is **only the headline/text baked onto the generated image**. Specifically:

| Site | What it truncates |
|---|---|
| repurpose.router.ts:271 (`deriveCreativeHeadline`) | carousel **cover** headline (image) |
| repurpose.router.ts:1220 | **static** post headline (image) |
| repurpose.router.ts:2010 (`regenerateImage`) | regenerated static/cover headline (image) |
| repurpose.router.ts:1256 / 2043 (`capHookLine`) | hook line for `hook_bars` (image) — ≤7 words |
| repurpose.router.ts:1627 `.slice(0,120)` | carousel **content slide** body (image) — char-cut, can chop mid-word |
| repurpose.router.ts:1661 `.slice(0,100)` | carousel **cover** body (image) — char-cut, can chop mid-word |

So the published caption is fine; we are fixing **image-baked text** only.

---

## 2. The fix (conservative, no layout regression)

Three coordinated changes. (A) is the core fix; (B) reduces how often capping triggers; (C) cleans up the secondary char-cuts.

### (A) Make `capHeadline` sentence/word-aware and align the budget to the renderer — CORE

Rewrite `capHeadline` so it **never ends mid-word and prefers ending on a natural boundary**, and raise the word budget to 16 (the renderer's real limit at 46px). New contract: **≤16 words AND ≤90 chars, never a partial trailing word, append `…` only when forced to drop content.**

```ts
/**
 * Cap a headline so it fits the creative template's largest comfortable size
 * tier WITHOUT ever ending mid-word. The template's headlineFontSize() renders
 * up to 16 words at 46px (creative-templates.ts:138), so 16 words / ~90 chars
 * is the real layout ceiling — not the old 12/80 guess.
 *
 * Strategy when over budget: keep whole words only; if we had to drop any
 * content, prefer cutting back to the last sentence-ending punctuation within
 * budget so the headline reads as a complete thought; otherwise append "…" so
 * it reads as deliberately abbreviated, never as a broken sentence.
 */
export function capHeadline(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const words = cleaned.split(" ");
  const MAX_WORDS = 16;
  const MAX_CHARS = 90;

  // Within budget on both axes → return as-is.
  if (words.length <= MAX_WORDS && cleaned.length <= MAX_CHARS) return cleaned;

  // Take whole words up to the word budget, then back off to the char budget
  // on a whole-word boundary (never a partial word).
  let out = words.slice(0, MAX_WORDS).join(" ");
  while (out.length > MAX_CHARS && out.includes(" ")) {
    out = out.slice(0, out.lastIndexOf(" "));
  }

  // Prefer ending on a sentence boundary if one exists late enough to keep
  // most of the headline (>= 60% of the kept text), so we end on a complete
  // clause rather than appending an ellipsis to a fragment.
  const lastStop = Math.max(out.lastIndexOf(". "), out.lastIndexOf("? "), out.lastIndexOf("! "));
  if (lastStop > out.length * 0.6) {
    return out.slice(0, lastStop + 1).trim();
  }

  // We dropped real content mid-thought → mark it abbreviated, not broken.
  return out.replace(/[\s,;:–—-]+$/, "").trim() + "…";
}
```

Why this is safe:
- **16 words / 90 chars** is inside the renderer's tested 46px tier — no clip, no new layout case.
- It only ever emits **whole words** → no "...Hormuz after" mid-word feel; worst case is a clean "…".
- Headlines already ≤16 words / ≤90 chars (the vast majority once (B) lands) pass through **unchanged** — identical behavior to today for the good path.

### (B) Tell the AI to produce ONE complete headline within the budget — reduces capping frequency

Make every headline-generation prompt ask for a **single complete headline of ≤14 words** (a hair under the 16-word cap, leaving headroom so the model's overshoot still fits). Align all of them to the same number and add the word "complete".

Edit the prompt strings:
- repurpose.router.ts:206 (`buildHeadlineRewritePrompt`): `max 12 words` → `one complete headline, max 14 words, no trailing fragments`
- repurpose.router.ts:249 (`deriveCreativeHeadline` social synth): `max 10 words` → `one complete, self-contained headline, max 14 words`
- repurpose.router.ts:1186 (static social synth): same edit as :249
- newsgrid.router.ts:189 (`max 12 words, punchy`) → `one complete headline, max 14 words, punchy` (keeps NewsGrid consistent)

This is prompt-only — no behavioral risk; it just makes the model self-limit so (A)'s cap rarely fires, and when it does the input is already short.

### (C) Make the carousel body char-cuts word-aware — secondary

repurpose.router.ts:1627 and :1661 use `.slice(0, 120)` / `.slice(0, 100)`, which can chop mid-word on the carousel **slide/cover body** text. Add a tiny shared helper and use it at both sites (and anywhere a body is char-cut):

```ts
/** Cut to maxChars on a whole-word boundary; append "…" only if content was dropped. */
export function capBody(text: string, maxChars: number): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxChars) return cleaned;
  let out = cleaned.slice(0, maxChars);
  if (out.includes(" ")) out = out.slice(0, out.lastIndexOf(" "));
  return out.replace(/[\s,;:–—-]+$/, "").trim() + "…";
}
```

Replace `s.trim().slice(0, 120)` → `capBody(s, 120)` (line 1627) and `extracted.description?.slice(0, 100)` → `capBody(extracted.description ?? "", 100) || ""` (line 1661).

> `capHookLine` (≤7 words) is intentionally short for the `hook_bars` 2-bar layout and already drops dangling `**` markers cleanly — **leave it as-is**. The user's complaint is the headlines, not the 7-word hooks.

---

## 3. Tests to update / add (regression safety)

These are the suites CLAUDE.md says must stay green, plus the one the fix necessarily changes:

1. **`packages/api/src/__tests__/cap-headline.test.ts`** — MUST be updated (its current assertions encode the OLD guillotine):
   - L5-9 "caps a >12-word headline to exactly 12 words" expecting `"one two ... twelve"` → rewrite to assert the **new 16-word contract**, that output is **whole-word only** (no partial trailing word), and ends on a boundary or `…`. Add a case proving a 16-word headline passes **unchanged** and a 20-word one ends in `…` on a word boundary (never mid-word).
   - L11-13 (short unchanged), L32-34 (trim) → keep, still pass.
   - L15-22 (≤80 char long-word) → update threshold to 90; keep the "no mid-word cut" assertion (now stronger).
2. **`packages/api/src/__tests__/repurpose-regenerate.test.ts`** (L243-246) — comment says "≤12 words AND ≤80 chars"; update to the new ≤16/≤90 contract so `expect(used).toBe(capHeadline(longHeadline))` still holds (it derives from the same function, so it stays green automatically — just fix the comment + any literal expectation).
3. **`packages/api/src/__tests__/repurpose-creative-notes.test.ts`** (L54-55) asserts the rewrite prompt `.toContain("max 12 words")` → update to the new prompt text (`max 14 words`).
4. **`packages/api/src/__tests__/derive-creative-headline.test.ts`** (L92) "caps the output to 12 words" → update to 16.
5. **New test for `capBody`** (the (C) helper): asserts whole-word boundary cut + `…`, and short input unchanged.

Run: `pnpm --filter @postautomation/api test` — all of the above plus the security-regression suites (`creative-templates.test.ts`, `image-fetch-ssrf.test.ts`, IDOR guards) must stay green. None of those touch capping, so they're unaffected.

---

## 4. Files to touch (exact)

| File | Change |
|---|---|
| `packages/api/src/routers/repurpose.router.ts` | (A) rewrite `capHeadline` (L281-286); (C) add `capBody`, use at L1627 + L1661; (B) edit prompt strings L206, L249, L1186 |
| `packages/api/src/routers/newsgrid.router.ts` | (B) edit prompt string L189 |
| `packages/api/src/__tests__/cap-headline.test.ts` | rewrite assertions for ≤16/≤90 + whole-word/ellipsis contract |
| `packages/api/src/__tests__/repurpose-regenerate.test.ts` | fix comment/expectation to new contract |
| `packages/api/src/__tests__/repurpose-creative-notes.test.ts` | update prompt-text assertion to `max 14 words` |
| `packages/api/src/__tests__/derive-creative-headline.test.ts` | update 12→16 word assertion |
| `packages/api/src/__tests__/cap-body.test.ts` (new) | cover the (C) helper |

## 5. What this deliberately does NOT change (no-sabotage guardrails)

- The published **caption** text — already untouched, stays untouched.
- The **font-size ladder** in creative-templates.ts / news-card-template.ts — unchanged; we cap to *within* its existing tested tiers (16 words / 46px), so no new render case is introduced.
- **`capHookLine`** (7-word hook for `hook_bars`) — unchanged by design.
- **Security sanitizers** (`safeColor`, `safeImageUrl`, `escapeHtml`, SSRF guards) — untouched; capping runs before them and emits only plain text.
- The **good path** (headlines already within budget) renders byte-identical to today.

## 6. Verification after implementation

1. `pnpm --filter @postautomation/api test` → green (incl. updated cap tests + security suites).
2. `pnpm --filter @postautomation/api exec tsc --noEmit` → no type errors.
3. Manual: repurpose a long-headline article (e.g. the "Strait of Hormuz" story) in `static`, `hook_bars`, and `carousel` — confirm the baked headline reads as a complete thought (ends on a word/clause or a clean "…"), never mid-word, at a readable size.
