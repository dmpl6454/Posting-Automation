# Platform Issues + Repurpose Overhaul — Design

**Date:** 2026-06-17
**Status:** Design approved (brainstorming complete) — ready for implementation plan
**Author:** Tabish + Claude
**Supersedes/extends:** none (additive to all prior Repurpose rounds 1–21b)

---

## Understanding Summary

- **What:** A combined, risk-phased fix for 12 verified platform issues plus 3 Repurpose feature gaps, spanning Repurpose/Content Studio, RSS, NewsGrid, Autopilot, Social Listening, and Approvals.
- **Why:** Captions are breaking in production today (REP-1, a dead Anthropic model ID), unreviewed AI content can auto-publish (AP-1), and two requested content capabilities (per-slide carousel text, postcard header+grid layout) don't exist.
- **Who:** Operators/users producing branded social content via the platform.
- **Key constraint (HARD):** **Additive-only, byte-identical default render path.** Nothing that works today may regress. New controls default OFF; with defaults untouched, every existing render is byte-identical (verified by render-diff test on the Moviefied reference + a URL case). This operationalizes "do not sabotage existing work."
- **Non-goals:** No fully-dynamic auto-layout grid (fixed presets only); no fixing Veo3/Gemini billing holds (external); no pixel-faithful mimicry of arbitrary references (documented known gap stays); no altering the working deterministic mimicry engine.

## Verification Discipline (why these issues are "real")

Every issue below was traced to specific code with file:line evidence by an independent verification pass (12-agent workflow + adversarial re-check on HIGH items + manual confirmation of the 2 agents that died). **3 candidate issues were REFUTED** (see Appendix A) — they are documented as verified-not-a-bug and intentionally NOT coded.

---

## Verified Issue Inventory

### HIGH (Phase 1 — ship first as an urgent PR)

**REP-1 — Production captions break when OpenAI fails.**
- Root cause: `packages/ai/src/providers/anthropic.provider.ts:5` hardcodes `claude-sonnet-4-20250514` — a date-suffixed, non-existent model ID → 404 `not_found_error`. Routed through `packages/ai/src/providers/provider.factory.ts:17`, so **all** Claude-text features inherit it (Super Agent, NewsGrid, Autopilot, Repurpose).
- The fallback chain (`packages/ai/src/utils/provider-chain.ts`) is structurally correct `[chosen → openai → anthropic]` but `throw lastErr` surfaces the *last* provider's error, masking that OpenAI failed first. The Anthropic leg being dead means there is effectively no working fallback when OpenAI is down.
- Fix: pin a valid current ID `claude-sonnet-4-6` (no date suffix — per the claude-api skill, valid IDs are `claude-opus-4-6` / `claude-sonnet-4-6` / `claude-haiku-4-5`) AND add an `ANTHROPIC_MODEL` env override mirroring `openai.provider.ts`'s `OPENAI_MODEL`, so the next model rotation never re-breaks it via code.
- Additive guarantee: pure correctness fix; no behavior change beyond "the fallback now works." No existing-working path touched.

**AP-1 — Autopilot posts skip the Review Queue (unreviewed auto-publish).**
- Root cause (adversarial re-trace): `apps/worker/src/workers/content-generate.worker.ts:326-329`:
  `const skipReview = agent.accountGroup?.skipReviewGate || autopilotPost.sensitivity === "LOW";`
  The `|| sensitivity === "LOW"` clause auto-approves even when the user's "Skip review gate" toggle is OFF — and `"LOW"` is the DEFAULT sensitivity classification (`packages/ai/src/tools/sensitivity-classifier.ts:17-29`). So most autopilot posts → `APPROVED`, bypass review, eligible to publish unreviewed.
- Fix: governance solely by the explicit flag: `const skipReview = agent.accountGroup?.skipReviewGate === true;`
- Additive guarantee: removing a *hidden* bypass; the explicit user toggle behavior is preserved exactly. Anyone who genuinely wants auto-approve still gets it via the existing flag.

### MEDIUM (Phase 2)

**NG-1 — NewsGrid creative renders on a black background.**
- Root cause: the stock-SVG fallback is a site-root-relative URL `/newsgrid-bg/bg-N.svg` inside Puppeteer `page.setContent` (base = `about:blank`), so it can't resolve → `.bg-photo` stays transparent → `body{background:#000}` shows through. (The tester's "billing hold" guess was wrong.) Secondary: the interactive NewsGrid generate mutation uses raw Gemini with no OpenAI fallback. `packages/ai/src/tools/news-card-template.ts:214-240`, `packages/api/src/routers/newsgrid.router.ts:282-317`.
- Fix: make the fallback self-contained — inline a CSS `linear-gradient` background (or embed the 6 SVGs as `data:image/svg+xml;base64`) so it renders under `about:blank`. Secondary: add the OpenAI fallback to the NewsGrid generate path.
- Additive guarantee: only changes the *fallback* (currently broken/black); the happy path (real photo present) is untouched.

**AP-3 — Autopilot Pipeline Logs show no detail.**
- Root cause: data IS captured; the UI reads camelCase aliases that don't exist on the row (`run.discovered`, `run.generated`, `run.finishedAt`) vs the real Prisma fields (`itemsDiscovered`, `postsGenerated`, `completedAt`; `packages/db/prisma/schema.prisma:853-861`). `apps/web/app/dashboard/autopilot/logs/page.tsx:71-101`.
- Fix: UI-only — read the real field names. No schema or query change needed for the core fix.
- Additive guarantee: read-only display fix; no data or behavior change.

**SL-1 — Social Listening mention badge stuck at 0 until refresh.**
- Root cause: `apps/web/app/dashboard/listening/page.tsx:139-143` — `syncMutation.onSuccess` invalidates `mentions` + `sentimentOverview` but NOT `listQueries`, and the badge value `q._count.mentions` (line 317) lives in `listQueries`.
- Fix: add `utils.listening.listQueries.invalidate()` to the sync `onSuccess` (one line).
- Additive guarantee: adds a missing invalidation; nothing removed.

**APPR-1 — No entry point to raise an approval request.**
- Root cause: `approval.submit` (`packages/api/src/routers/approval.router.ts:6-77`) is fully implemented but has ZERO callers app-wide (grep-confirmed). The Approvals page wires only `list` + `review`; there is no "Submit for review" UI.
- Fix: add a "Submit for review" action (post composer + posts list) that opens a reviewer picker and calls `trpc.approval.submit({ postId, reviewerIds })`. Connect autopilot to it (AP-1's other half: autopilot should create an ApprovalRequest instead of silently bypassing).
- Additive guarantee: new UI calling an existing, tested mutation; no existing flow altered.

### LOW (Phase 3)

**RSS-1 — Raw Zod JSON leaks into the error toast.**
- Root cause: `apps/web/lib/errors.ts:22-34` `humanizeError` only filters known technical substrings + messages > 240 chars; a short (~128-char) Zod-error JSON passes through verbatim. The errorFormatter already exposes structured `data.zodError` (unused). **Shared across 15+ call sites.**
- Fix: in `humanizeError`, read `err.data?.zodError` (preferred) or detect a leading `[{` JSON array → friendly message. Secondary: client-side URL-format check in the RSS add-feed handler.
- Additive guarantee: improves error text only; no functional change.

**NG-2 — "1 channels" pluralization.** `apps/web/app/dashboard/newsgrid/page.tsx:771,884` hardcode the plural (line 773's idle button already pluralizes correctly). One-line conditional each.

**AP-4 — Autopilot agent delete has no confirmation.** `apps/web/app/dashboard/autopilot/agents/page.tsx:210` fires delete directly; inconsistent with RSS/campaigns/channels which use `confirm()`. Add the same confirm gate.

### Repurpose Features (Phase 4 — separate PRs each)

**REP-2 — Per-slide carousel text editing.** Today: slide text is all AI-generated; only slide-0 (cover) has Regenerate; inline headline edit is static-only (`mediaUrls.length === 1`). Build: inline editable headline + body per slide (cover, every body slide, CTA) + per-slide Regenerate-image button.

**REP-3 — Postcard header+grid layout.** Today: not producible — the router only ever feeds one `bgImageUrl`; the engine has `renderTweetHeader` + `photoGrid` primitives but they're unwired; no multi-image slot UI. Build: fixed-preset collages (2-up / 3-up / 2×2) as a single composited static image, header above grid, slots filled from uploads (primary) / article-scraped images / AI-per-empty-slot.

**REP-4 — Canva-like free-drag positioning.** Build: pixel-precise freehand drag on a live preview for the logo and the hook-layout text; capture as `{xPct, yPct}` (% of canvas); pass as an OPTIONAL positioning prop. Absent → existing corner/anchor behavior (byte-identical default). Present → `position:absolute; left:X%; top:Y%` for that one element.

---

## Decision Log

| # | Decision | Alternatives | Rationale |
|---|---|---|---|
| D1 | Combined plan, **phased by risk**, separate PRs | One mega-PR; group by root-cause family | Land production-down + safety fixes fastest; smaller PRs review safer |
| D2 | **Phase 1 = REP-1 + AP-1** | Fold into general plan | Both HIGH (production-down + unreviewed auto-publish) |
| D3 | Pin **`claude-sonnet-4-6`** + add `ANTHROPIC_MODEL` env override | Opus 4.6; leave hardcoded | Cost-appropriate fallback; env override prevents future rotation breakage |
| D4 | AP-1: **remove `|| sensitivity === "LOW"`** clause | Keep but default-off | Review governed only by explicit `skipReviewGate` (default false) |
| D5 | Postcard = **fixed presets (2-up/3-up/2×2)** | Dynamic auto-layout; 2-up only | Covers Moviefied examples; bounded work |
| D6 | Grid slots: **uploads / article-scraped / AI-per-empty-slot** | Uploads only | Mirrors existing slot-resolver precedence; graceful empty-slot handling |
| D7 | Per-slide = **edit + regenerate every slide** | Edit-only; pre-gen only | Full control; closes the flagged gap |
| D8 | Drag = **free X/Y freehand**, stored `{xPct,yPct}` | 9-anchor snap; extend corner picker | Canva feel; resolution-independent; maps onto 1080×1350 |
| D9 | **Safety bar: additive-only + byte-identical default render path** (render-diff test on Moviefied + URL case) | Visual spot-check; full snapshot suite first | Testable "don't sabotage" gate; test infra exists |
| D10 | Refuted items **documented, not coded** | Polish anyway; re-verify live | Verified not-a-bug with proof; avoid re-report churn |
| D11 | Group shared-root-cause fixes where severity aligns | Per-screen patches | Smaller net change, lower risk |

## Risks & Mitigations

- **R1 — Regression to the 21 rounds of mimicry work (highest risk).** Mitigation: D9 byte-identical default-path render-diff test; every new control opt-in/OFF by default.
- **R2 — REP-1 fix needs the real Anthropic key set in prod.** Mitigation: Phase 1 design verifies `.env.prod` has `ANTHROPIC_API_KEY`; if absent, the fix is moot until set (note in plan).
- **R3 — Free-drag coordinate plumbing to server renderer is the most novel code.** Mitigation: build behind an optional prop; live preview uses the same %-coords; add a render test asserting absent-prop = corner default.
- **R4 — AP-1 fix could surprise users who relied (unknowingly) on auto-approve.** Mitigation: the explicit `skipReviewGate` flag still gives auto-approve to anyone who wants it; document the behavior change in the PR.
- **R5 — APPR-1 + AP-1 interaction.** Autopilot should create ApprovalRequests; sequence APPR-1's submit-path before wiring autopilot into it.

## Testing Strategy

- **Per phase:** the byte-identical render-diff gate (D9) for any rendering change; `pnpm --filter @postautomation/ai test` + `@postautomation/api test`; bare `tsc --noEmit`; and `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (SWC catches syntax tsc accepts — burned in Round 13).
- **REP-1:** unit test asserting the provider chain falls OpenAI→Anthropic and the Anthropic model id is a valid non-date-suffixed string.
- **AP-1:** worker test asserting a LOW-sensitivity post with `skipReviewGate=false` lands in `REVIEWING`, not `APPROVED`.
- **Security regression suites stay green:** `creative-templates.test.ts`, `image-fetch-ssrf.test.ts`, ownership/IDOR suites.

## Appendix A — Refuted candidates (verified NOT a bug, NOT coded)

- **RSS-2** ("empty submit = silent no-op"): the Add Feed button is `disabled={!name || !url}` (`rss/page.tsx:240`), dimmed + pointer-events-none — standard pattern.
- **AP-2** ("Agents page hangs after Run"): `runNow` enqueues and returns immediately; page uses auto-clearing react-query `isPending`, no stream/poll. Not reproducible in code.
- **SL-2** ("deleted queries persist"): delete `onSuccess` DOES invalidate `listQueries` (`listening/page.tsx:134`) — correctly wired (mirror of SL-1). If observed live, likely a one-off; code is correct.
