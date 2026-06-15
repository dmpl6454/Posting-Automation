# Repurpose — Reference-Faithful Render (2026-06-15)

## Understanding summary
- Drive repurpose's STATIC + CAROUSEL render from a **detailed OpenAI-vision read of the user's style reference** → the existing `CardSpec`/`renderCard` block engine, reproducing the reference's real structure (photo/text proportions, gradient blend, headline scale+position+alignment, logo placement, colors, wordmark) — not "pick 1 of 4 fixed templates."
- Why: the 4 fixed templates only approximate; repeated near-misses (moviefied → cramped headline, weak gradient, broken logo placeholder, composite photo).
- Who: operator running consistent brand pages (Moviefied, Bollywood Chronicle …) repurposing news into on-brand cards.

## Decisions locked (Decision Log)
1. **Fidelity = layout-faithful now, auto-upgrade later.** OpenAI-vision → CardSpec → renderCard now (matches layout/proportions/gradient/colors, not pixel-identical fonts). When Gemini billing is restored, the Gemini image-to-image (`referenceImages`) path auto-engages for pixel-faithful output — no further code change. *Alt rejected:* pixel-only (blocked by billing), 4-template approximation (the failing status quo).
2. **UI = reference-first.** Default: format → paste/upload reference (or pick saved style) → optional brand logo+color → Generate. 4-style/theme/logo-position knobs auto-derive from the reference, hidden behind **Advanced**. *Alt rejected:* keep-all-controls, two-mode switch.
3. **Clipboard image-paste** for the reference (not just file upload).
4. **Hero photo:** default to the article's best single image; one-click override via paste / upload / library. *Alt rejected:* auto-crop composites (risky face-detection), use-as-is (today's problem).
5. **Scope = Static + Carousel only.** Reel + AI-video unchanged (a video can't mimic a still post's layout); they only inherit brand logo/color.
6. **Saved style stores the extracted spec** → re-apply with NO new vision call.

## Assumptions / risks
- **A3 (KEY RISK):** the `CardSpec` block engine is expressive enough for these layouts (hero-photo region, gradient block, scaled+positioned headline, logo shape/position, wordmark/label). **MUST verify against card-engine.ts before building; extend the engine if a block is missing.**
- **A4:** OpenAI vision reliably extracts a rich layout spec. Mitigate: constrained JSON schema + sane defaults + low-confidence fallback to today's behavior.
- **A5 (security):** every color/url/text sanitized (engine has `sanitizeCardSpecJson` + safeColor/safeImageUrl); SSRF-guarded reference/photo fetch; Puppeteer render. No new external services.
- **A6:** high-impact/high-risk (replaces the core render path) → build behind the existing flow (fallback), visual-verify against `~/Downloads/MoviefiedPostRef.jpg`, adversarial review before ship.

## Build order (front-load visual risk)
1. Verify engine expressiveness (A3) → use-as-is or extend.
2. Prove the RENDERER can hit the moviefied layout from a rich spec (render + compare to ref).
3. Vision extractor: reference image → rich layout spec.
4. Wire extractor → renderCard into repurpose static + carousel cover/slides (fallback to current on low-confidence).
5. Saved-style stores spec; Gemini auto-upgrade path; best-photo + override.
6. UI: reference-first + Advanced toggle + clipboard paste.
7. Visual verify end-to-end vs ref; tests; adversarial security review; ship.
