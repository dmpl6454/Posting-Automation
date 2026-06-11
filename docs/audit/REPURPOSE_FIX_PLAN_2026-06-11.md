# Repurpose flow — fix plan (2026-06-11, round 6)

Scope: Content Studio **Repurpose** tab end-to-end only (router mutation + regenerate, UI, creative renderers, worker video path, publish/draft handoff). Not a full-app audit.

How this was produced: a 7-finder adversarial-verify workflow hit the session token limit after only the **security** finder + 4 surfaced candidates completed; the verifier agents died (so the workflow's "refuted" list is unreliable — a dead verifier counts as refuted). I re-verified every candidate by hand against current code and swept the highest-value areas the killed finders never reached. Every item below was confirmed by direct code read, with file:line. Items are ordered by severity.

> NOTE: nothing here is implemented yet — this is the plan only.

---

## F1 — SSRF in URL extraction (the main fetch is ungated) · **HIGH**

**Where:** [packages/ai/src/utils/url-extractor.ts:106-149](../../packages/ai/src/utils/url-extractor.ts#L106-L149) (`fetchHtmlWithFallback`, attempts 1 & 2), reached via `extractWebPage` → `extractUrlContent` ([url-extractor.ts:796](../../packages/ai/src/utils/url-extractor.ts#L796)), called with `input.url` in the repurpose mutation.

**Defect:** `extractUrlContent` only does `new URL(url)` (syntax check). `fetchHtmlWithFallback` then does `fetch(url, { redirect: "follow" })` with **no** `isPublicPageUrl` gate, and `redirect:"follow"` means even a public URL can 30x-redirect to an internal host. The response **body is reflected** into `extracted.body/title/description`, which the UI shows in the preview and the AI turns into captions/headline. So an authenticated user can point the repurpose URL at `http://169.254.169.254/latest/meta-data/...`, `http://10.x`, or a public URL that redirects there, and read internal/metadata content back through the captions. The `resolveImageFromPageUrl`/og:image path IS already gated ([url-extractor.ts:291](../../packages/ai/src/utils/url-extractor.ts#L291)) — only the **primary HTML fetch** is not.

**Fix:**
1. In `extractUrlContent` (and/or at the top of each `extractWebPage`/platform extractor), reject non-public hosts up front: `if (!isPublicPageUrl(url)) throw new Error("That URL host isn't allowed.")`. `isPublicPageUrl` is already imported in this file.
2. In `fetchHtmlWithFallback`, change attempts 1 & 2 to `redirect: "manual"` and, on a 3xx, re-validate the `Location` host with `isPublicPageUrl` before following (one bounded hop), OR keep `follow` but re-validate the **effective** `res.url` after the fetch and discard the body if it resolved to a private host.
3. The `r.jina.ai` proxy hop (attempt 3) goes to a fixed public host with the user URL in the path — lower risk, but the proxy itself could be told to fetch internal hosts; gate the *input* url (step 1) so a private url never reaches the proxy string.
4. Add a regression test (mirror `image-fetch-ssrf.test.ts`): `extractUrlContent("http://169.254.169.254/")` and a public→private redirect both throw/empty, a normal article still extracts.

---

## F2 — HTML/JS injection into headless Chrome via `overlayLogoOnImage` · **MEDIUM**

**Where:** [packages/ai/src/tools/news-image-generator.ts:245-248](../../packages/ai/src/tools/news-image-generator.ts#L245-L248). Reached live from the **carousel/reel** branch: `applyLogoOverlay(...)` ([repurpose.router.ts:1366](../../packages/api/src/routers/repurpose.router.ts#L1366)) → `overlayLogoOnImage({ channelName, accentColor, ... })` where `channelName = input.channelName` (mutation input, attacker-controllable at the tRPC boundary even though the UI sends a real channel name).

**Defect:** `channelName` is interpolated **raw** into the page HTML (`...>${channelName}</div>`, line 248) and `accentColor` is interpolated **raw** into a `background:${accentColor}` style (line 245). The sibling renderer `news-card-template.ts` correctly `escapeHtml()`s its `channelName`/`source`/`headline` and the static path uses `safeColor` — this overlay renderer was missed. A crafted `channelName` (`</div><script>fetch('http://169.254.169.254/...')</script>`) executes inside the server-side Puppeteer context (own-tenant blast radius, but a script in headless Chrome can pivot to SSRF / local file reads / hang the render). The logo URL on line 244 IS already SSRF-gated (`safeLogoUrl`).

**Fix:**
1. `escapeHtml(channelName)` on line 248 (and escape `channelHandle` if/when `handleHtml` is reinstated — currently `""`).
2. Gate `accentColor` on line 245 with the same `safeColor` (strict `^#[0-9a-fA-F]{3,8}$` → default) used by `creative-templates.ts`; import/share it rather than re-implementing.
3. The `initial` (line 235) is a single upper-cased char — low risk, but escape it too for uniformity.
4. Extend `creative-templates.test.ts` (or a new `logo-overlay-escaping.test.ts`) to assert `</div><script>`, `"><img onerror>`, and a CSS `url()` breakout in `channelName`/`accentColor` are all neutralized.

---

## F3 — Cross-org media IDOR in `post.create` (the publish handoff) · **MEDIUM**

**Where:** [packages/api/src/routers/post.router.ts:142-148](../../packages/api/src/routers/post.router.ts#L142-L148).

**Defect:** `post.create` maps `input.mediaIds` straight into `mediaAttachments.create` with **no org-ownership check**. `channelIds` ARE validated (lines 94-119), and `chat.router` + the new `post.update` channel path have guards, but `post.create` mediaIds are unguarded. An authenticated user can attach another org's `Media` row to their post — the attached media's S3 URL is then surfaced in the post and published. The in-app repurpose UI only sends org-scoped ids (from `uploadAndCreateMedia`), so the normal flow is safe, but the API boundary is exploitable. `assertMediaOwned` already exists in `chat.router.ts:41`.

**Fix:**
1. Before the `post.create`, validate ownership: `await assertMediaOwned(ctx.prisma, ctx.organizationId, input.mediaIds)` (export/reuse the chat-router helper, or inline a `media.findMany({ where: { id: { in }, organizationId } })` count check identical to the channel block above).
2. Apply the same guard to `post.update` if it ever accepts `mediaIds` (it currently doesn't — channels only — so no change needed there yet).
3. Regression test mirroring `chat-action-media.test.ts`: a foreign mediaId in `post.create` → FORBIDDEN; own ids → ok.

---

## F4 — Carousel cover headline skips all the static-branch headline intelligence · **MEDIUM**

**Where:** [repurpose.router.ts:1578](../../packages/api/src/routers/repurpose.router.ts#L1578): `const coverHeadline = capHeadline(extracted.title);`. Compare the static branch ([repurpose.router.ts:1044-1186](../../packages/api/src/routers/repurpose.router.ts#L1044-L1186)).

**Defect:** the carousel cover uses the **raw extracted title**, so it misses three things the static branch does:
- **Social-post headline synthesis** (`extracted.type === "social"` → synthesize a clean headline from the caption). A carousel from an IG/FB post link gets a garbled/long caption as its cover headline.
- **Generic-title → `briefSubject` preference** (homepage/section URLs yield `"... | The Indian Express"`; static swaps in the AI `SUBJECT:`). Carousel covers keep the junk title.
- **Notes-aware rewrite + hook wiring** (`buildHeadlineRewritePrompt` / `buildHookLinePrompt`, shipped today). So "mention Doordarshan in the hook" works for static but is **silently ignored for carousel** — exactly the class of bug just fixed for static.

**Fix:** extract the static branch's headline-derivation into a shared helper (e.g. `deriveCreativeHeadline({ extracted, contentBrief, contentSummary, creativeNotes, provider })` returning `{ headline, hookLine? }`) and call it from BOTH the static branch and the carousel cover. Then `coverHeadline` gets social synthesis + generic-title handling + notes rewrite, and the cover can render a `hook_bars` hook line when that style is selected, matching the static cover. Reuse `capHeadline`/`capHookLine`. Add a test asserting a social-type carousel cover headline is synthesized (not the raw caption) and that creativeNotes reach the cover.

---

## F5 — "From Text" is a degraded path that silently drops format/brand/style/notes · **MEDIUM (product)**

**Where:** UI [RepurposeTab.tsx:512-518](../../apps/web/components/content-agent/RepurposeTab.tsx#L512-L518) (`handleGenerate`, `sourceMode === "text"` branch) vs the card copy at [RepurposeTab.tsx:562-564](../../apps/web/components/content-agent/RepurposeTab.tsx#L562-L564).

**Defect:** the card promises *"Paste a URL **or text content** to create social media posts, carousels, or reels."* But the From-Text branch calls the **legacy `repurpose.mutate({ originalContent, targetPlatforms, provider })`** — captions only, no media, and it forwards NONE of: `format`, `creativeStyle`, brand color/logo, aesthetic ref, notes, theme, slideCount, channels, progressId. So a user who pastes text gets text captions and no image/carousel/reel/branding at all, with no UI signal that the format/style controls they may have set don't apply.

**Fix (pick one, recommend A):**
- **(A) Wire text through the full pipeline.** Add an optional `rawText` (or make `url` a `z.union`) to the main mutation; when present, skip `extractUrlContent` and build `extracted` from the pasted text (title = first line/AI-summarized, body = text, type = "text"), then run the identical media/format/brand/notes pipeline. This is the honest fix and removes a whole second code path.
- **(B) Scope the promise.** If text-to-media is out of scope for now: in the text tab, hide/disable the format/style/brand/notes controls (or show "Text mode generates captions only"), and change the card copy so it doesn't promise carousels/reels for text.

Confirm the `<TabsContent value="text">` block ([RepurposeTab.tsx:1053](../../apps/web/components/content-agent/RepurposeTab.tsx#L1053)) and which controls render there before choosing — if it already hides the media controls, this is just copy (B-lite); if it shows them, it's misleading (A or full B).

---

## F6 — Regenerate ignores edited notes for the hook/headline text · **LOW**

**Where:** `regenerateImage` mutation [repurpose.router.ts:1846-1991](../../packages/api/src/routers/repurpose.router.ts#L1846-L1991).

**Defect:** regenerate folds `imageContext` (notes) into the **background-image** prompt (line 1943-1946) but reuses the client-supplied `hookLine` and `headline` verbatim. So if a user edits the notes ("mention Doordarshan in the hook") and clicks Regenerate, the *hook wording* doesn't change — only the background re-rolls. The main flow now derives hook/headline from notes; regenerate doesn't. Minor because regenerate's stated job is "re-roll the image," but it's a surprise once notes affect text elsewhere.

**Fix (small):** when `regenerateImage` receives a non-empty `imageContext`, optionally re-run `buildHookLinePrompt` (for `hook_bars`) / `buildHeadlineRewritePrompt` to refresh the hook/headline from the notes before rendering — OR document/label that regenerate keeps the original wording and only re-rolls visuals (set expectations in the button tooltip). If F4's shared `deriveCreativeHeadline` helper lands, regenerate can call it too for full parity. Recommend deferring to whatever F4 produces.

---

## Verified-NOT-a-bug (checked, leaving alone)

- **Worker video progress finalization** — both success ([repurpose-video.worker.ts:319](../../apps/worker/src/workers/repurpose-video.worker.ts#L319)) and the `catch` ([:322-330](../../apps/worker/src/workers/repurpose-video.worker.ts#L322-L330)) call `finishProgress(scoped, "done"|"error")`, so the activity-log spinner always finalizes. The `video_ready`/`video_error` done-publish is present. Clean.
- **`mediaFailed` reporting** — the static/carousel/video branches set `mediaFailed = mediaUrls.length === 0` and finalize with an honest error step ([repurpose.router.ts:1802-1811](../../packages/api/src/routers/repurpose.router.ts#L1802-L1811)). Clean.
- **regenerate SSRF + plan gate** — `enforcePlanLimit("aiImagesPerMonth")` first, then `logoUrl`/`aestheticRefUrl`/`bgImageUrl` all gated by `isPublicImageUrl` before any fetch ([:1872-1937](../../packages/api/src/routers/repurpose.router.ts#L1872-L1937)). Clean.
- **`news-card-template.ts` escaping** — `headline`/`source`/`channelName`/`logoUrl` all `escapeHtml`'d ([news-card-template.ts:87-262](../../packages/ai/src/tools/news-card-template.ts#L87-L262)). Clean (only the *overlay* sibling, F2, is unsafe).
- The workflow's "refuted" list is **not** trustworthy (verifiers died on session limit); F1/F2/F3/F4 from that list are in fact REAL per the hand-verification above.

## Suggested sequencing

Security first (F1, F2, F3) → quality (F4) → product (F5) → polish (F6, ideally folded into F4's helper). F1+F2+F3 are small, isolated, and testable; ship them as one PR with regression tests. F4+F5 are larger (shared-helper extraction / new text path) and can be a second PR.

## Re-run note

The deep-review workflow was cut off by the session token limit (resets ~15:20 IST). To get the static-path / video-path / templates-rendering / ui-wiring / extraction finders' full output (this plan covers them via manual sweep but not exhaustively), re-run after reset:
`Workflow({ scriptPath: ".../repurpose-deep-review-wf_78cfae3b-806.js", resumeFromRunId: "wf_78cfae3b-806" })` — the completed security finder returns cached; the killed agents re-run live.
