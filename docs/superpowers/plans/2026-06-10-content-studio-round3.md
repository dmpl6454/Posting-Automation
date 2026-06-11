# Content Studio — Round 3 (Quality + Correctness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. Fresh implementer subagent per task + two-stage review (spec then quality).

**Goal:** Fix the 6 verified Content Studio issue clusters reported after Phase 3 shipped: blank hook+headline statics, broken Regenerate, carousel slide-count off-by-2 + same-y/blank slides, the no-op aesthetic reference, the text-heavy Seedance video, and the forever-spinning video progress.

**Architecture:** All changes confined to `packages/api/src/routers/repurpose.router.ts`, `packages/ai/src/tools/creative-templates.ts`, `packages/ai/src/utils/safe-fetch-url.ts`, `packages/ai/src/utils/url-extractor.ts`, `packages/ai/src/providers/seedance.provider.ts`, `apps/worker/src/workers/repurpose-video.worker.ts`, `apps/worker/src/lib/repurpose-video.ts`, and `apps/web/components/content-agent/RepurposeTab.tsx`. **No Prisma schema changes** → zero migration risk. Builds on Phases 1/2a/2b/3 (all live in prod at main `17e0582`).

**Tech Stack:** Next.js, tRPC v11, Prisma, BullMQ, Puppeteer (creative render), ffmpeg via `execFileSync` (NO shell — keep it that way), fal.ai Seedance, Vitest, pnpm@9.15.0 (NOT npm). `noUncheckedIndexedAccess` is ON — guard `arr[0]` with `!` in tests/code. Vitest does NOT type-check: RUN both `pnpm --filter @postautomation/<pkg> test` AND `pnpm --filter @postautomation/<pkg> exec tsc --noEmit` per task.

**Source analysis:** verified root-cause findings in workflow `wf_b133151f-32b` (6/7 investigators + 23 adversarial verifiers; only static-blank RC1 refuted). Cross-cutting facts:
- **hook_bars/bold_typographic are NOT background-less** — they intentionally render `themeTokens.bgFallback` (flat `#f7f7f8` on default light theme = the "blank" look). `renderStaticCreative` has NO `bgImageUrl` arg today.
- **`bold_typographic`'s template DISCARDS `bgImageUrl` entirely** (no `.bg` div, never reads `opts.bgImageUrl`) — needs its own template work.
- **Prod billing-403 message does NOT match `isSafetyBlock`** → in prod every image goes straight to gpt-image-1 with the RAW prompt (no `sanitizePrompt` real-person guard, no reference images). So any real-person guard must be UNCONDITIONAL in the prompt, not via the safety-retry path.
- **Aesthetic references are Gemini-only by construction** (gpt-image-1 fallback drops them) → currently invisible in prod (Gemini billing hold). Vision-describe via OpenAI is the provider-agnostic fix.
- **`safeFetchImage` is S3-allowlist-only** — cannot be reused for external logo/aesthetic URLs; a new `safeFetchPublicImage` (public-host + content-type + redirect:manual + byte-cap) is needed.

**Locked product decisions (from user, do NOT re-ask):**
1. hook+headline styles → use the **article photo** as background (scrim for legibility), brand-accent gradient when no photo. `bold_typographic` needs template work to honor it.
2. Aesthetic reference → **vision-describe via OpenAI** (provider-agnostic) appended to the prompt + og:image extraction for social/post page URLs. Keep passing `referenceImages` so Gemini conditioning resumes when billing is fixed.
3. Carousel slide count → means **TOTAL slides** (cover + content + CTA). Gate the math to `format === "carousel"` so reel does NOT shrink.
4. Ship as **one PR** on branch `fix/content-studio-round3` (already created off `17e0582`).

---

## Task ordering rationale

Tasks 1-3 are shared enablers (helpers + template surface). Tasks 4-11 are the per-issue fixes that consume them. Task 12 is UI. Do them in order; later tasks depend on earlier signatures.

---

### Task 1: `safeFetchPublicImage` helper (shared enabler — SSRF/content-type/byte-cap)

**Files:** Modify `packages/ai/src/utils/safe-fetch-url.ts`. Test: extend `packages/ai/src/__tests__/image-fetch-ssrf.test.ts`.

**Why:** the three reference fetches in the router (logo, aesthetic, regenerate) use bare `fetch()` with no content-type check, no timeout, no byte cap, and default redirect-follow (an `isPublicImageUrl`-passing URL can 302 to a metadata host). Centralize a safe variant.

- [ ] **Step 1 — failing tests.** In `image-fetch-ssrf.test.ts` add tests for a new `safeFetchPublicImage(url, opts?)` exported from `safe-fetch-url.ts`:
  - rejects (returns `null` or throws — pick `null` for caller simplicity) when `isPublicImageUrl(url)` is false;
  - rejects when the (mocked) response `content-type` is `text/html`;
  - rejects when the (mocked) body exceeds `maxBytes`;
  - on a `30x` response with a `Location` to `http://169.254.169.254/...`, does NOT follow it (uses `redirect: "manual"`, returns `null`);
  - on a valid `image/png` response under the cap, returns `{ base64, mimeType: "image/png" }`.
  Mock `global.fetch` per the existing test conventions in that file.
- [ ] **Step 2** run → fail (function not exported).
- [ ] **Step 3 — implement.** Add to `safe-fetch-url.ts`:
  ```ts
  export async function safeFetchPublicImage(
    url: string,
    opts?: { maxBytes?: number; timeoutMs?: number },
  ): Promise<{ base64: string; mimeType: string } | null> {
    if (!isPublicImageUrl(url)) return null;
    // data:image inline — decode directly (isPublicImageUrl already allowed it)
    if (url.startsWith("data:image/")) {
      const [, mimeType = "image/png", b64 = ""] = url.match(/^data:(image\/[a-zA-Z+]+);base64,(.*)$/s) ?? [];
      return b64 ? { base64: b64, mimeType } : null;
    }
    const maxBytes = opts?.maxBytes ?? 8 * 1024 * 1024;
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return null;
    }
    if (!res.ok) return null; // manual redirect → res.ok is false for 30x; treat as failure
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!/^image\/(png|jpe?g|webp|gif)/.test(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return null;
    const mimeType = ct.split(";")[0]?.trim() || "image/png";
    return { base64: buf.toString("base64"), mimeType };
  }
  ```
  (Mirror `safeFetchImage`'s timeout/redirect handling; the difference is the gate is `isPublicImageUrl` not `isAllowedImageUrl`, plus the content-type/byte-cap enforcement.)
- [ ] **Step 4** tests green + `pnpm --filter @postautomation/ai exec tsc --noEmit` exit 0.
- [ ] **Step 5** commit `feat(ai): safeFetchPublicImage helper (content-type + redirect-manual + byte-cap)`.

### Task 2: `resolveImageFromPageUrl` (og:image extraction for social/post URLs)

**Files:** Modify `packages/ai/src/utils/url-extractor.ts` (export a new function). Test: new `packages/ai/src/__tests__/resolve-image-from-page.test.ts`.

**Why:** an Instagram/FB **post page** URL is `text/html`, not an image. To use it as a style reference, extract its `og:image`. `getMeta`/`getImages` already exist but are module-private.

- [ ] **Step 1 — failing test.** Test `resolveImageFromPageUrl(url)`:
  - given a mocked HTML body containing `<meta property="og:image" content="https://cdn.example.com/p.jpg">`, returns `https://cdn.example.com/p.jpg`;
  - falls back to `twitter:image` when no `og:image`;
  - returns `null` when neither present;
  - returns `null` when the fetch content-type is not `text/html` (don't parse binary);
  - returns `null` on fetch error.
  Mock `global.fetch`.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** In `url-extractor.ts`, add an exported async function that fetches the page (`redirect: "manual"`, `AbortSignal.timeout(8000)`, cap HTML read at ~2MB), verifies `content-type` includes `text/html`, then reuses the existing `getMeta(html, "og:image")` / `getMeta(html, "twitter:image")` helpers to return the first hit (or `null`). Do NOT export `getMeta`/`getImages` themselves (keep them private) — only the new wrapper. **Do NOT** export it from the `@postautomation/ai` package root unless other Phase-3 internals are (match `decodeEntities` which is internal-only); the router imports from the deep path it already uses for url-extractor, or add it to the existing url-extractor export surface the router consumes.
- [ ] **Step 4** tests green + ai tsc exit 0.
- [ ] **Step 5** commit `feat(ai): resolveImageFromPageUrl — og:image extraction for social/post page URLs`.

### Task 3: `renderStaticCreative` gains a real `bgImageUrl` arg + hoist `capHeadline`; template fallbacks improved

**Files:** Modify `packages/api/src/routers/repurpose.router.ts` (`renderStaticCreative` signature/body ~141-208; hoist `capHeadline` from the closure at ~736 to module level next to `capHookLine`), `packages/ai/src/tools/creative-templates.ts` (richer light fallback for `hook_bars`; make `bold_typographic` honor `bgImageUrl`). Test: extend `packages/ai/src/__tests__/creative-templates.test.ts`.

**Why:** the shared enabler for static-blank RC2/RC3/RC5 + regenerate. Today `renderStaticCreative` only ever sets `bgImageUrl` from its OWN AI generation; a caller cannot pass a pre-existing photo. And `hook_bars`'s flat `#f7f7f8` no-photo fallback + `bold_typographic` ignoring `bgImageUrl` are the "blank" look.

- [ ] **Step 1 — failing tests** in `creative-templates.test.ts`:
  - `buildHookBars` with NO `bgImageUrl` and `theme:"light"` must NOT emit the bare `background:#f7f7f8` flat fill — assert the rendered HTML contains a gradient (e.g. `linear-gradient(`) OR a `.bar` border/tint rule so it isn't white-on-white. (Pick: gradient fallback.)
  - `buildBoldTypographic` with a `bgImageUrl: "https://x/y.jpg"` must now render a `.bg`/`background-image` referencing that URL (today it discards it). Keep the accent band.
  - Security regression still green: `buildHookBars`/`buildBoldTypographic` with a malicious `bgImageUrl` (`</style><script>`, CSS `url()` breakout) drops it via `safeImageUrl` (re-assert).
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.**
  - **creative-templates.ts:** In `buildHookBars` (~187-219), when `!safeBg`, replace the flat `background:${tokens.bgFallback}` with a brand-accent gradient reusing the gradient-theme pattern (`linear-gradient(135deg, ${safe}, #11131a)` à la line ~110, where `safe` = `safeColor(opts.brandColor)`), so the photo-less case is a branded gradient, not white. In `buildBoldTypographic` (~265-288), add the same `const safeBg = safeImageUrl(opts.bgImageUrl); const bg = safeBg ? \`background-image:url('${safeBg}');background-size:cover;background-position:center;\` : \`background:${gradient};\`` pattern + a dark scrim overlay so the headline stays legible, while keeping the accent band. ALL `bgImageUrl` interpolation MUST go through the existing `safeImageUrl` (do NOT interpolate raw — keep the XSS guard).
  - **repurpose.router.ts:** add optional `bgImageUrl?: string` to `renderStaticCreative`'s args object (~141-160). Initialize `let backgroundImageUrl: string | undefined = args.bgImageUrl;` (line ~163) so a passed-in photo is the default background. Keep the AI-generation block (170-186) as an OVERRIDE only when `styleNeedsAiBackground` is true (it already sets `backgroundImageUrl`/`bgSource="ai"`). When `args.bgImageUrl` is used and AI is skipped, set `bgSource = "stock"` (it's a real article photo, not AI). The conditional spread at ~204 already forwards `backgroundImageUrl`.
  - **Hoist `capHeadline`:** move the closure at ~736 to a module-level `export function capHeadline(text: string): string` next to `capHookLine` (~65). Replace the in-closure use with the module-level one. (Needed by regenerate, Task 8.)
- [ ] **Step 4** `pnpm --filter @postautomation/ai test` + `@postautomation/api` tsc + `@postautomation/ai` tsc all green/exit 0.
- [ ] **Step 5** commit `feat: renderStaticCreative accepts a real bgImageUrl + branded no-photo fallbacks + hoist capHeadline`.

### Task 4: Static branch — plumb the article og:image as background (hook+headline fix)

**Files:** Modify `packages/api/src/routers/repurpose.router.ts` static branch (~791-899) + `buildHeadlineCreative` (~549-589). Test: new `packages/api/src/__tests__/repurpose-static-bg.test.ts`.

**Why:** static-blank RC2/RC3 — the extracted `extracted.images[0]` (og:image) is never plumbed to the renderer, so hook_bars renders photoless. Per the locked decision, use the article photo.

- [ ] **Step 1 — failing test.** Pure helper `pickArticleBgImage(images: string[], isAllowed: (u:string)=>boolean): string | undefined` → returns the first `https`/`data:image` image passing `isAllowed`, else `undefined`. Test: picks first allowed; skips `http://` (safeImageUrl rejects it downstream, so filter here too — match `safeImageUrl`'s `^(https:\/\/|data:image\/...)` rule); returns undefined for empty/all-disallowed.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** Add `pickArticleBgImage` (module-level). In the static branch, compute `const articleBg = pickArticleBgImage(extracted.images, isPublicImageUrl);` and pass it through `buildHeadlineCreative` → `renderStaticCreative({ ..., bgImageUrl: articleBg })`. For `premium_editorial`/`tweet_card` (which already do AI bg), the article photo becomes the AI-bg FAILURE fallback: in `renderStaticCreative`'s catch (~187-189), `backgroundImageUrl = args.bgImageUrl ?? backgroundImageUrl`. For hook_bars/bold_typographic (AI skipped), `args.bgImageUrl` IS the background. **`http://` og:images:** `safeImageUrl` rejects them; either upgrade to `https://` or fetch+inline via `safeFetchPublicImage` (Task 1) as a data URL — do the simple `https`-only filter in `pickArticleBgImage` for this pass and note http images are dropped (acceptable; most og:images are https).
- [ ] **Step 4** `pnpm --filter @postautomation/api test` + api tsc + ai tsc green.
- [ ] **Step 5** commit `feat: static creative uses the article og:image as background (hook+headline no longer blank)`.

### Task 5: Carousel — plumb article photo on cover + per-slide visual variety + unconditional real-person guard

**Files:** Modify `packages/api/src/routers/repurpose.router.ts` carousel slide loop (~1254-1283, bgPrompt ~1262-1266) + `renderStaticCreative`'s prompt assembly (~179) for the people guard. Test: new `packages/api/src/__tests__/repurpose-carousel-prompt.test.ts`.

**Why:** carousel RC2 (every slide ~95% identical prompt, no variety, no real-person guard on the image path) + carousel RC3 (no fallback bg).

- [ ] **Step 1 — failing tests.** Pure helpers:
  - `slideAngleDescriptor(slideIdx: number): string` → rotates over `['wide establishing shot','close-up detail','overhead flat-lay','abstract geometric pattern','environment/location shot']` by `idx % len`. Test rotation + wraparound.
  - `buildCarouselSlidePrompt({ slideTitle, slideBody, slideIdx, totalSlides, categoryTone, imageContext }, appendImageContext)` → includes the angle descriptor, a `Slide N of M` marker, an explicit "visually DISTINCT from the other slides" instruction, the slide's OWN body (not the whole contentBrief), and the unconditional no-real-person clause. Test that two different `slideIdx` produce different angle text and that the real-person clause is always present.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.**
  - Add the two helpers (module-level). In the carousel loop, replace the shared `\`Cinematic background photo for: "${slideMeta.title}". ${contentBrief}\`` with `buildCarouselSlidePrompt(...)` using only CATEGORY/TONE extracted from contentBrief (the `/CATEGORY:/`+`/TONE:/` regex slice) — NOT the full SUBJECT/VISUAL brief — plus the slide's own body + angle + distinctness instruction.
  - **Unconditional real-person guard:** in `renderStaticCreative`'s prompt assembly (~179, where the theme/suffix is appended before `generateImageSafe`), append a clause mirroring `seedance.provider.ts:277`: `" Do NOT depict any specific, real, named public figure or recognizable real person; use anonymous, generic people only."` This must be on the prompt UNCONDITIONALLY (prod path bypasses `sanitizePrompt`).
  - **Cover photo:** pass the validated `extracted.images[0]` (via `pickArticleBgImage` from Task 4) as `bgImageUrl` for the COVER slide (`slideRole === "cover"`) so the cover has a real photo when AI bg is skipped (hook_bars/bold_typographic) or fails.
  - **AI-bg failure fallback:** in `renderStaticCreative`'s catch, the `args.bgImageUrl` fallback (Task 4) now gives body slides the article photo instead of blank — acceptable; OR leave body slides token-rendered. Per the loop, pass cover the article photo; body/cta keep current behavior (they get the variety prompt for AI bg). Document the choice in a comment.
- [ ] **Step 4** api test + api/ai tsc green.
- [ ] **Step 5** commit `feat: carousel slide variety (per-slide angle/body) + unconditional real-person guard + cover article photo`.

### Task 6: Carousel slide count = TOTAL (gated to format==="carousel", reel unchanged)

**Files:** Modify `packages/api/src/routers/repurpose.router.ts` (schema comment ~327-329; carousel/reel branch ~1164, slidePrompt ~1166, fallback slice ~1204, enforce call ~1209-1213). Test: update `packages/api/src/__tests__/repurpose-slidecount.test.ts`.

**Why:** carousel RC1 — `slideCount` means content slides; cover+CTA added → picked 3 yields 5. User wants TOTAL. The branch handles BOTH carousel and reel; the picker is carousel-only, so reel must keep default content count.

- [ ] **Step 1 — failing test.** Update `enforceSlideCount` tests if its contract changes — but prefer keeping `enforceSlideCount` as content-count (pure) and computing `contentCount = max(1, total - 2)` at the call site. Add a test for a new pure helper `contentSlidesForTotal(total: number): number` → `Math.max(1, total - 2)` (3→1, 5→3, 10→8). Assert reel path is unaffected (it doesn't call this helper / uses its own default).
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** In the carousel branch ONLY (`format === "carousel"`), derive `const contentCount = contentSlidesForTotal(input.slideCount);` and use `contentCount` everywhere `input.slideCount` currently drives content-slide counts: the slide-extraction prompt ("exactly ${contentCount} key points"), the fallback `sentences.slice(0, contentCount)`, and `enforceSlideCount(slideData, contentCount, ...)`. The reel branch must NOT use `contentCount` — it keeps its existing default (verify it doesn't read `input.slideCount`; if it does, gate so reel is unaffected). Update the schema comment (327-329) to "total slides incl. cover + CTA; min 3 = cover+1+cta".
- [ ] **Step 4** api test (slidecount suite updated + green) + api tsc.
- [ ] **Step 5** commit `feat: carousel slideCount means TOTAL slides (cover+content+CTA); reel slideshow unchanged`.

### Task 7: Aesthetic reference — safe fetch + og:image + provider-agnostic vision-describe

**Files:** Modify `packages/api/src/routers/repurpose.router.ts` (aesthetic fetch ~509-539 logo + ~528-539 aesthetic; bgPrompt assembly). Test: new `packages/api/src/__tests__/repurpose-aesthetic-describe.test.ts`.

**Why:** aesthetic RC1-5 — references are Gemini-only (dead in prod), no content-type/og:image handling, SSRF gaps. Make it work provider-agnostically.

- [ ] **Step 1 — failing test.** Pure helper `buildStyleDescriptorPrompt(): string` (the fixed instruction text for the vision model: "Describe this image's visual style in <=40 words: palette, lighting, composition, mood, medium. No subject/people description."). And test the integration via mocks: given a mocked vision-describe returning `"warm cinematic palette, soft rim light, shallow depth"`, the assembled bgPrompt CONTAINS that descriptor (appended via `appendImageContext`). Mock the vision call + `safeFetchPublicImage`.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.**
  - Replace the three bare `fetch()` reference blocks (logo ~509-520, aesthetic ~528-539, and in regenerate Task 8) with `safeFetchPublicImage` (Task 1). On `text/html`, call `resolveImageFromPageUrl` (Task 2), re-validate with `isPublicImageUrl`, then `safeFetchPublicImage` the resolved og:image. If still no image, `progress("Style reference","skipped","could not read an image from that link")` and continue (do NOT fail the whole job).
  - **Vision-describe (provider-agnostic):** after the aesthetic ref is fetched (a base64 image), call an OpenAI vision model ONCE (gpt-4o-mini; reuse the multimodal `image_url` plumbing — the chat-agent.chain LangChain branch passes `new HumanMessage({content: m.content})` with `image_url` parts) with `buildStyleDescriptorPrompt()`, get the ≤40-word descriptor, and append it to `bgPrompt` via `appendImageContext` (so it conditions the gpt-image-1 background in prod). Compute ONCE and reuse for every carousel slide. Keep pushing the image into `brandReferenceImages` too (so Gemini conditioning resumes when billing returns). Default the describe call to OpenAI (NOT the Gemini-first chain — Gemini text/vision is also billing-held).
  - Wrap the vision-describe in try/catch: on failure, skip silently (don't block image gen) and `console.warn`.
- [ ] **Step 4** api test + api/ai tsc green.
- [ ] **Step 5** commit `feat: aesthetic reference works provider-agnostically (safe fetch + og:image + OpenAI vision-describe → prompt)`.

### Task 8: Regenerate parity — return rendered headline + hookLine; resend; cap; shared logo resolver

**Files:** Modify `packages/api/src/routers/repurpose.router.ts` (`repurposeFromUrl` responses ~1420-1437 static / ~1376-1398 reel; `regenerateImage` ~1448-1546 input schema + body) + `apps/web/components/content-agent/RepurposeTab.tsx` (results state, `handleRegenerate`). Test: extend `packages/api/src/__tests__/repurpose-regenerate.test.ts`.

**Why:** regenerate RC1-4 — regenerate sends the RAW page title (no cap/synthesis), no `hookLine`, headline-only bg prompt, and skips DB logo resolution. So hook_bars regenerates blank + others render off/overflowing.

- [ ] **Step 1 — failing tests.** Assert:
  - `regenerateImage` input schema now accepts optional `hookLine?: z.string()`, `bgImageUrl?: z.string().url()`, `bgContext?: z.string().max(600)`; and when `creativeStyle === "hook_bars"` with a `hookLine` provided, the `renderStaticCreative` call receives that `hookLine` (mock + assert).
  - the headline passed to render is `capHeadline`-capped (mock a 30-word headline → assert ≤12 words / 80 chars reaches the renderer).
  - `bgImageUrl` (when provided + `isPublicImageUrl`) reaches `renderStaticCreative`.
  - Keep the existing plan-gate + SSRF tests green.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.**
  - **Return rendered values:** add `renderedHeadline` (the `headlineForCreativeFinal` for static / `coverHeadline` for carousel) and `hookLine` (when generated) to the `repurposeFromUrl` response objects (~1420-1437, ~1376-1398). Store them on the UI `results` state (~118-127).
  - **regenerateImage input:** add optional `hookLine`, `bgImageUrl` (`z.string().url().optional()`, validated with `isPublicImageUrl` before use), `bgContext` (`z.string().max(600).optional()`). Apply module-level `capHeadline` (Task 3) to `input.headline` at ~1521. Pass `hookLine` + `bgImageUrl` into `renderStaticCreative` (~1531-1546). Interpolate `bgContext` into the bg prompt (~1523-1529) through `sanitizePrompt`.
  - **Shared logo resolver:** extract the main flow's logo-resolution chain (~411-454: input.logoUrl → DB `category:"logo"` media → channel metadata.logo_path → channel avatar) into a module-level helper `resolveLogoForOrg(prisma, { organizationId, logoUrl, channelName, channelHandle })` and call it from BOTH the main flow and `regenerateImage` (before ~1484) so logo + derived brandColor match.
  - **UI `handleRegenerate` (~366-388):** send `headline: results.renderedHeadline ?? results.extracted?.title`, `hookLine: results.hookLine`, `bgImageUrl: pickArticleBgImage(results.extracted?.images ?? [])`, `bgContext: results.extracted?.description?.slice(0,600)`. (Note: regenerating a non-cover carousel body slide replaces it with a static-style page-title creative — acceptable for this pass; the UI only exposes Regenerate on the static image + carousel COVER per the findings, so this is fine.)
- [ ] **Step 4** api test (regenerate suite green) + api tsc + web tsc.
- [ ] **Step 5** commit `feat: Regenerate parity — rendered headline + hookLine + bgImage + bgContext + shared logo resolver`.

### Task 9: Seedance prompt — generate VISUALS ONLY (no on-screen text)

**Files:** Modify `packages/ai/src/providers/seedance.provider.ts` `buildSeedancePrompt` (~254-278). Test: update `packages/ai/src/__tests__/seedance-prompt.test.ts`.

**Why:** seedance-text RC1 — the prompt AFFIRMATIVELY commands the model to render the title + every key point + CTA as on-screen text (`Bold white text "${point}"`, `Text: SUPER BOLD`), with zero anti-text clause → the model paints (and garbles) the whole script.

- [ ] **Step 1 — failing test.** Assert `buildSeedancePrompt(...)`:
  - does NOT contain `Bold white text` / `SUPER BOLD` / `Text:` directives;
  - CONTAINS a hard negative clause forbidding on-screen text (assert a substring like `Do NOT render any on-screen text`);
  - still contains the people clause + 9:16 aspect (keep existing assertions);
  - still produces a non-empty prompt that visually depicts each key point.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** Rewrite `buildSeedancePrompt` (254-278): change the scenes mapper (263-265) to `Scene ${i+2}: Cinematic B-roll visually depicting: ${point}.`; change Scene 1 (271) to a textless opening shot describing the subject visually (drop the zooming title text); delete the Final-scene CTA typography line (273) and the `Text: SUPER BOLD...` directive (276); drop `with bold text overlays` from the opening sentence (267); append after the people line (277): `" Do NOT render any on-screen text, words, letters, numbers, captions, subtitles, lower-thirds, chyrons, titles, logos, watermarks, or typography of any kind anywhere in the video."`. Keep `title` in the prompt only as subject context, not as a text directive (or drop it from on-screen instruction). Ensure the test's title/9:16/people assertions still pass.
- [ ] **Step 4** `pnpm --filter @postautomation/ai test` + ai tsc green.
- [ ] **Step 5** commit `fix(ai): Seedance prompt generates visuals only — forbid all on-screen text`.

### Task 10: Seedance caption burn — one clean title line, time-sliced scene captions

**Files:** Modify `apps/worker/src/workers/repurpose-video.worker.ts` (burn call ~271, drawtext build ~86-94) + `apps/worker/src/lib/repurpose-video.ts` (`burnCaptionsOnVideo` ~73-132). Test: extend the worker/lib tests for `repurpose-video`.

**Why:** seedance-text RC2 — the worker burns 5 permanent caption lines (title + first 4 scenes) covering the bottom ~third for the whole clip. Reduce to a clean lower-third.

- [ ] **Step 1 — failing test.** For the pure caption-layout helper: assert that given a title + 4 scenes + a clip duration, the produced drawtext filter list has the TITLE without `enable=` (persistent) and each scene caption with an `enable='between(t,START,END)'` window (non-overlapping, equal segments = duration/sceneCount), at most ~2 lines visible at once. Assert the `between(t,a,b)` commas/colons are inside filtergraph single-quotes (NOT escaped). Keep `escapeDrawText` security assertions green (escapes `"`, strips control chars). **Keep ALL ffmpeg via `execFileSync` (no shell) — do NOT regress to `exec`/`execSync`.**
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** Extend `burnCaptionsOnVideo` to accept either `string[]` (back-compat) or a `{ title: string; scenes: string[]; durationSeconds: number }` shape (pick the cleaner signature; the only caller is the worker). Build: one persistent title drawtext (lower-third, fixed y) + one rotating scene caption at a time via `enable='between(t,i*seg,(i+1)*seg)'` (`seg = durationSeconds / scenes.length`) at a y just above the title. Reduce fontsize if needed for 720×1280. At the worker call (~271) pass `{ title: sd.title, scenes: sd.scenes.slice(0,4), durationSeconds: sd.duration }` (the duration is `clampVideoDuration`'d already / available near ~260). Update the now-accurate invariant comment at ~67-71. **The `enable='between(...)'` expression's single quotes are filtergraph-level — keep them; the commas are safe BECAUSE of that quoting, and since it's an `execFileSync` array element there's no shell to also worry about.**
- [ ] **Step 4** `pnpm --filter @postautomation/worker test` + worker tsc + (lib in worker) green.
- [ ] **Step 5** commit `fix(worker): Seedance caption burn — persistent title + time-sliced scene captions (less on-screen text)`.

### Task 11: Progress finalization — worker re-publishes "done" + client finalizes on terminal event + scenes-count reorder

**Files:** Modify `apps/worker/src/workers/repurpose-video.worker.ts` (add "done" publishes ~after 236/265/271/280), `apps/web/components/content-agent/RepurposeTab.tsx` (finalize running→done in the `video_ready` branch + `__finished__` branch; running→error in `isVideoErrorEvent`), `packages/api/src/routers/repurpose.router.ts` (move the "Extracting key points" done-publish after the fallback ~1101→after 1109; same for veo3 ~916-929). Test: extend `apps/web/lib`-adjacent tests + a worker progress test.

**Why:** progress RC1-4 — the worker only ever publishes the three video steps as "running"; the client closes the SSE stream on `video_ready` before `__finished__` arrives and never maps `running→done`; the scenes-count step publishes "0 scenes" before the sentence fallback fills it.

- [ ] **Step 1 — failing tests.**
  - Pure client helper `finalizeRunningSteps(steps, status)` → maps every `status==="running"` step to `status` (`"done"` or `"error"`). Test it leaves non-running steps untouched.
  - Worker: assert that the seedance path publishes a `"done"` status for each of `"Generating AI video (Seedance)"`, `"Adding captions"`, `"Uploading video"` (and reel: `"Stitching reel video"`) — assert via the pushProgress mock call list.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.**
  - **Worker:** after `generateSeedanceVideo` resolves, `pushProgress(scoped, "Generating AI video (Seedance)", "done", \`${sd.duration}s clip\`)`; after `burnCaptionsOnVideo`, `pushProgress(scoped, "Adding captions", "done")`; after `uploadVideoToS3`, `pushProgress(scoped, "Uploading video", "done", \`${mb}MB\`)`; for the reel branch, after stitch `pushProgress(scoped, "Stitching reel video", "done")`. (Client dedupes by step name → spinner flips to checkmark.)
  - **Client (RepurposeTab.tsx):** add `finalizeRunningSteps`. In the `video_ready` branch (~before `closeVideoStream()` at ~194) call `setProgressSteps(prev => finalizeRunningSteps(prev, "done"))`; in the `__finished__` branch (~165) when status `"done"` do the same (self-heals the sync path); in `isVideoErrorEvent` (~197) call `finalizeRunningSteps(prev, "error")`. Place the finalize in the `video_ready` branch (the client closes the stream there, so `__finished__` is never seen on the video path).
  - **Scenes count (router):** relocate/re-publish the `"Extracting key points for video scenes" "done"` step to AFTER the `if (keyPoints.length === 0)` sentence fallback (~after 1109) so the detail reports the real count; apply the same reorder to the veo3 `ai_video` branch (~916-929). (Re-publishing after the fallback is preferable to a pure relocate — it also reconciles the catch/error path.)
- [ ] **Step 4** `pnpm --filter @postautomation/web exec tsc --noEmit` + worker test/tsc + api tsc green.
- [ ] **Step 5** commit `fix: video progress finalizes (worker done-publishes + client running→done on terminal event) + scenes-count after fallback`.

### Task 12: UI wiring for the new controls + honest copy

**Files:** Modify `apps/web/components/content-agent/RepurposeTab.tsx`. Test: web tsc (UI; logic covered by helper tests above).

**Why:** surface Task 6 (total-slide label), Task 7 (optional URL paste for aesthetic ref), and fix misleading copy ("AI-generated background" subtitle shows even for styles that skip AI bg; "Content slides" label).

- [ ] **Step 1 — implement.**
  - **Slide count label (Task 6):** change the segmented-control `<Label>` (~848) from "Content slides" to "Total slides" and the footnote (~863) to "Includes a cover and a follow-for-more slide." The `[3,5,7,10]` buttons now mean total.
  - **Aesthetic URL paste (Task 7):** next to the file upload (~768-805) add a small "or paste an image/post URL" text input that sets `aestheticRefUrl`; if the host looks like a social domain or the URL lacks an image extension, show a hint "we'll grab the post's image automatically." Also strip bare URLs out of `imageContext` before submit (or warn "links don't work in style notes") so a URL pasted there doesn't leak into the prompt as literal text.
  - **Honest subtitle:** where the generated-image card subtitle says "AI-generated background with branded overlay", make it conditional — for `hook_bars`/`bold_typographic` show "Branded design with article photo" (these don't use AI bg).
- [ ] **Step 2** `pnpm --filter @postautomation/web exec tsc --noEmit` exit 0.
- [ ] **Step 3** commit `feat(ui): total-slide label + aesthetic URL paste + honest creative subtitle`.

---

## Final gate (after all tasks)
- [ ] `pnpm --filter @postautomation/{ai,api,queue,worker} test` all green; `pnpm --filter @postautomation/web exec tsc --noEmit` exit 0.
- [ ] Root `pnpm type-check` 7/7 + `pnpm build` 9/9.
- [ ] Confirm invariants preserved: SSRF guards (`isPublicImageUrl`/`isAllowedImageUrl`/new `safeFetchPublicImage` redirect:manual+content-type+byte-cap), IDOR org-scoping (logo resolver org-scoped, userMediaIds unchanged), plan gates (`regenerateImage` still `enforcePlanLimit` FIRST), `execFileSync` no-shell ffmpeg (Task 10), XSS sanitizers (`safeImageUrl`/`safeColor`/`escapeHtml` on all template interpolations incl. new `bgImageUrl` on bold_typographic), carousel Media-row publish path unchanged, light-theme default unchanged.
- [ ] Confirm no-regression-when-unused: every new field optional; reel slideshow count unchanged; premium_editorial/tweet_card behavior unchanged except article-photo failure-fallback.
- [ ] Final full-diff adversarial review (focus: prompt-injection via vision-describe/imageContext, SSRF on og:image resolution + redirect, ffmpeg `enable=between` filtergraph quoting correctness, slide-count math for reel vs carousel, bold_typographic XSS via new bgImageUrl path).
- [ ] superpowers:finishing-a-development-branch → PR `fix/content-studio-round3` → `main`. Then confirm prod deploy with the user (per established per-phase pattern).
