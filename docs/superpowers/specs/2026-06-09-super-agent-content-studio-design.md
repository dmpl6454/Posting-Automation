# Design: Super Agent + Content Studio (Repurpose) — End-to-End Fix

**Date:** 2026-06-09
**Branch:** `fix/audit-2026-06-06` (continue) or a new `fix/super-agent-content-studio`
**Audit source:** [docs/audit/2026-06-09-super-agent-content-studio-audit.md](../../audit/2026-06-09-super-agent-content-studio-audit.md)

This design fixes every reported issue in the Super Agent and Content Studio / Repurpose
modules, plus the additions agreed during brainstorming: a **4-style creative renderer**,
**brand reference images saved as reusable templates**, and a **graceful no-reference path**.

User decisions (locked):
- Creative styles: build **all four** (Premium editorial, Hook+headline bars, Tweet/post
  card, Bold typographic) in one pass; defaults at my discretion.
- Brand refs: **logo + auto-extracted brand color**, corner placement, logo passed as a
  reference image to the generator. **Reusable as a saved template.** **Must also work with
  no reference given.**
- Video formats: keep Veo3 **visible but disabled** ("Temporarily unavailable"); relabel
  Reel → "Slideshow Reel", Seedance → "AI Video".
- Social URLs: **decode entities + harden extractors + smart-fallback headline synthesis**
  (no paid API).

---

## Architecture overview

Two boundaries, kept isolated:

1. **Creative renderer** (`packages/ai`): pure functions `opts → HTML → PNG`. One builder
   per style behind a single `buildStaticCreative(style, opts)`. The repurpose router and
   any other caller stay style-agnostic.
2. **Creative templates** (`packages/db` + `packages/api`): a thin storage/convenience
   layer that persists the renderer's brand *inputs* (not content) for reuse. Org-scoped
   CRUD, guarded like existing `Media`/channel ownership. Does **not** change the renderer.

The Super Agent fixes are independent of the above and touch only the chat stream route,
chat router action payloads, and the chat-agent prompt.

---

## MODULE A — Super Agent

### A1. Multimodal vision (the core "upload doesn't work" bug)
> **Adversarial-review correction (2026-06-09):** the LangChain side of this works as
> claimed, but the Gemini branch and the `ChatMessage` type need real refactoring — they
> currently only handle plain strings. Vision-provider routing is also broken in two ways
> (see A1b). Evidence cited inline.

**Files:** `apps/web/app/api/chat/stream/route.ts`, `packages/ai/src/chains/chat-agent.chain.ts`,
`packages/ai/src/providers/gemini.provider.ts`, `packages/ai/src/routing/smart-router.ts`

**A1a — carry image parts through to the model:**
- Stream route: change the history query to include attachments + media:
  `attachments: { select: { media: { select: { url, fileType } } } }`.
- **Widen the `ChatMessage` type** (`chat-agent.chain.ts:8-11`, currently `content: string`)
  to `content: string | (MessageContentComplex | DataContentBlock)[]` so multimodal content
  can propagate. The `AIChatMessage` export widens with it.
- **LangChain branch (OpenAI/Anthropic) — CONFIRMED supported.** `@langchain/core@0.3.80`
  `HumanMessage` accepts `content: string | (MessageContentComplex | DataContentBlock)[]`
  including `{type:"image_url", image_url:{url, detail?}}`. Replace `new HumanMessage(m.content)`
  (`chat-agent.chain.ts:177`) with one that passes array content through unchanged when the
  message has attachments.
- **Gemini branch — NEEDS REFACTOR (was wrong in v1 spec).** `callGemini(prompt: string)`
  (`gemini.provider.ts:26-29`) accepts a string ONLY and the Gemini branch
  (`chat-agent.chain.ts:194-200`) formats messages as plain text — neither supports images.
  Refactor `callGemini` to accept `Content[] | string` (`@google/generative-ai@0.24.1`) and,
  for image messages, build `Part[]` with `{inlineData:{mimeType, data}}` (base64). The
  Gemini branch must build these parts instead of flattening to text.
- **Image source:** prefer the stored S3 `url` as `image_url` for OpenAI/Anthropic. For
  Gemini's `inlineData` (and any provider rejecting remote URLs), fetch the S3 object and
  inline as base64. Helper `toImagePart(media, provider)` picks the right shape.

**A1b — route to a vision-capable provider (TWO bugs to fix):**
- **Bug 1:** `hasAttachments` is **hardcoded `false`** at `stream/route.ts:142`. `routeProvider`
  *does* correctly return `gemini` when `hasAttachments` is true (`smart-router.ts:129-131`),
  but never receives `true`. Fix: detect attachments from the loaded messages and pass the
  real boolean.
- **Bug 2:** `FALLBACK_PRIORITY` (`stream/route.ts:156`) includes **`grok`, `deepseek`,
  `gemma4` — none vision-capable** (grok-3 @ api.x.ai, deepseek-chat: no vision API). If the
  routed provider fails and fallback lands on one, vision silently breaks. Fix: when
  attachments are present, restrict the fallback set to vision providers ONLY —
  `["openai" (gpt-4o), "anthropic" (claude), "gemini"]`. Non-vision providers stay in the
  text-only fallback set.

**Acceptance:** Upload an image → "what is this image?" → the agent returns a real
description of the actual image, on the routed provider AND any fallback it lands on.

### A2. Action media plumbing
**Files:** `apps/web/app/dashboard/super-agent/page.tsx`, `packages/api/src/routers/chat.router.ts`
- The client already tracks `attachments` (with `mediaId`). When executing a `publish_now`
  / `schedule_post` action whose payload lacks media, the client merges the **current
  thread's last user-message attachment mediaIds** into `payload.mediaIds`.
- `executeAction` `schedule_post` / `publish_now` / `bulk_schedule`: accept optional
  `p.mediaIds: string[]`, validate each belongs to `ctx.organizationId` (reuse the same
  org-scoped `media.findMany` guard pattern), and attach to the created post's media
  relation. Keep `assertChannelsOwned` + `enforcePlanLimit` exactly as they are.

**Acceptance:** Upload an image → "post this to <channel>" → a `publish_now` action is
produced carrying the mediaId; the published/created post has the image attached.

### A3. Prompt awareness
**File:** `packages/ai/src/prompts/chat-agent.prompt.ts`
- Add an **ATTACHED MEDIA** section: "When the user attaches an image, you can see and
  describe it. When they say 'post this' / 'publish this', attach the image to the post
  (the platform will include it). Do not claim you cannot see images."

---

## MODULE B — Content Studio / Repurpose

### B2 + B3. Four-style creative renderer (fixes ugly static post + carousel cover)
**Files:**
- `packages/ai/src/tools/news-card-template.ts` (or a new `creative-templates.ts`): add the
  four style builders + a `StaticCreativeOptions` type with `style` discriminator and a
  `buildStaticCreative(style, opts): string` dispatcher.
- `packages/ai/src/tools/news-image-generator.ts`: `generateStaticNewsCreativeImage` calls
  the dispatcher by style (keeps Puppeteer render, `waitUntil:"load"`, stock-bg fallback).

**`StaticCreativeOptions` (shared inputs):**
`{ style, headline, hookLine?, subhead?, bgImageUrl?, secondaryImageUrl?, logoUrl?|null,
   logoPosition: "top-left"|"top-right", brandColor?, channelName, handle?, verified?, tag?, date? }`

**The four styles (each a pure `opts → HTML`):**
1. **`premium_editorial`** (default for static) — full photo + gradient scrim; logo in
   chosen corner; small italic brand label with accent underline; large bold white headline
   bottom-left. (Mirrors the user's Krrish/Moviefied reference.)
2. **`hook_bars`** — full photo; two stacked bottom caption bars: a punchy "hook" line
   (supports word-level highlight markup `**word**`/`==word==` → brand-color/red spans +
   emoji) over a factual headline bar; optional inset **circular cutout** of
   `secondaryImageUrl`. (Mirrors the TMC/Pushpa reference.)
3. **`tweet_card`** — white **or** dark card styled like a tweet: circular logo + bold
   brand name + verified tick + @handle, text on top, photo(s) below (supports a
   side-by-side pair via `bgImageUrl` + `secondaryImageUrl`). (Mirrors the Conrad Fisher ref.)
4. **`bold_typographic`** — huge headline on solid/brand-colored background, minimal/no
   photo; small corner logo + channel name. For quotes/statements.

**Defaults:** static → `premium_editorial`; carousel cover → `premium_editorial` (consistent
brand look). The UI style picker lets the user override per generation.

**Carousel cover (B3):** `repurpose.router.ts` cover branch keeps calling
`buildHeadlineCreative`, which now renders via the chosen style → cover inherits the new
design automatically. Content/CTA slides keep their AI-designed look.

### B4. Brand reference images (+ reusable templates + no-reference path)

**No-reference path (must work):** resolution order for the logo is
`input.logoUrl → saved template logo → DB media (category "logo") → channel avatar → none`.
If **none**, the renderer omits the logo block and uses a default accent color — the
creative still renders cleanly (logo-less). Generation NEVER blocks on a missing reference.

**Reference, when given:**
- UI (`RepurposeTab.tsx`): a "Brand reference" panel — logo uploader (or pick from Media
  Library / channel avatar), a logo-position toggle (top-left/top-right), and an optional
  preview. Reuses the existing `/api/upload` + `MediaPickerDialog`.
- Router: extract dominant color from the logo via existing `extractDominantColor` →
  `brandColor` accent; pass the logo as `referenceImages:[{base64,mimeType}]` to
  `generateImageSafe` so the AI background is styled to the brand. Bake the logo into the
  template corner per `logoPosition`.

**Reference handling across providers (CORRECTED 2026-06-09 — original plan was impossible):**
> **Adversarial-review correction:** the v1 plan to use OpenAI `/v1/images/edits` with
> `gpt-image-1` for reference images is **WRONG and would 400 every call.** `/v1/images/edits`
> supports **`dall-e-2` only** — and per CLAUDE.md this account has **NO dall-e access, only
> `gpt-image-1`**. The endpoint is also `multipart/form-data` with a single `image` field
> (no `image[]`), not JSON. There is no OpenAI path to reference-conditioned generation on
> this account. So:
- **AI reference conditioning (logo/style → background photo) is Gemini-only.** Nano Banana
  natively accepts `referenceImages` (`nano-banana.provider.ts`), and `generateImageSafe`
  already forwards them. We pass the logo there. **When Gemini is on its billing hold, the
  AI background simply won't be brand-conditioned** — it falls back to OpenAI `gpt-image-1`
  *generation* (no reference), which is fine because…
- **Logo placement is deterministic and provider-independent.** The logo is composited by
  our **Puppeteer creative template** (corner per `logoPosition`) and the accent color comes
  from `extractDominantColor` — NOT from the AI image model. So the brand always shows
  correctly regardless of which image provider produced the background, and during the
  Gemini hold the creative still looks branded (logo + brand color baked by the template).
- **Do NOT call `images/edits`.** Leave `editImageDallE` as-is (documented no-op). Remove the
  v1 claim about an OpenAI reference path from the implementation.

**Reusable templates (new):**
- `packages/db/prisma/schema.prisma`: new model + **required back-relations** (Prisma fails
  `db:push` validation without the opposite relation field — corrected 2026-06-09):
  ```
  model CreativeTemplate {
    id             String   @id @default(cuid())
    organizationId String
    organization   Organization @relation(fields:[organizationId], references:[id], onDelete: Cascade)
    name           String
    style          String         // "premium_editorial" | "hook_bars" | "tweet_card" | "bold_typographic"
    logoMediaId    String?
    logoMedia      Media?   @relation(fields:[logoMediaId], references:[id], onDelete: SetNull)
    logoPosition   String   @default("top-right")
    brandColor     String?
    channelId      String?        // optional scoping to a channel
    createdById    String
    createdBy      User     @relation(fields:[createdById], references:[id])  // matches DesignTemplate convention
    createdAt      DateTime @default(now())
    updatedAt      DateTime @updatedAt
    @@index([organizationId])
  }
  ```
  **Also add back-relation fields** (or `db:push` errors):
  - `Organization`: `creativeTemplates CreativeTemplate[]`
  - `Media` (model at ~line 334-358): `creativeTemplates CreativeTemplate[]`
  - `User`: `creativeTemplates CreativeTemplate[]`
  Mirror the existing `DesignTemplate` model (`schema.prisma:877-896`) for naming/conventions.
  Applied via `pnpm db:push` (additive, no destructive change).
- `packages/api/src/routers/creative-template.router.ts` (new): `list`, `create`, `update`,
  `delete`, all `orgProcedure`, org-scoped; `create`/`update` validate `logoMediaId` belongs
  to the org (reuse the IDOR-guard pattern). Mounted in the root router.
- `RepurposeTab.tsx`: a "Brand template" dropdown (lists org templates) + "Save as template"
  button on the brand-reference panel. Selecting a template pre-fills style + logo +
  position + brandColor. Templates are pure convenience — they pre-fill the same `opts` the
  UI collects manually; the renderer is unchanged.

### B5. Video format menu
**File:** `apps/web/components/content-agent/RepurposeTab.tsx`
- `FORMAT_OPTIONS`: Veo3 stays listed but rendered **disabled** with a "Temporarily
  unavailable" badge (billing hold) and a tooltip. Relabel: `reel` → "Slideshow Reel"
  (desc: "Your key points become video slides with optional voiceover + music"),
  `seedance_video` → "AI Video" (desc: "Real AI-generated cinematic footage with native
  audio"). Static/Carousel descriptions tightened. No backend enum change (the `ai_video`
  path stays but is unreachable from the UI while disabled).

### B6. Social-post URL ingestion
> **Adversarial-review correction (2026-06-09):** the v1 plan would NOT fully fix the
> garbling. `getMeta()` (`url-extractor.ts:189-203`) returns the **raw** string match with
> no decoding; IG/FB titles come from `getMeta(html,"og:title")` (`:379`, `:575`) and flow
> straight to the headline, then get **double-escaped** by `escapeHtml` in the template
> (`news-card-template.ts:100-106` → `&quot;` becomes `&amp;quot;`). And synthesis only
> firing for "generic" titles (`repurpose.router.ts:442-449`) skips real IG/FB captions.
> Three precise fixes required:

**File:** `packages/ai/src/utils/url-extractor.ts`
1. **Universal HTML-entity decoder** `decodeEntities(s)` — named (`&quot; &amp; &#39; &lt;
   &gt; &nbsp;`) + numeric/hex (`&#x1f37f; &#8217;`) incl. emoji. **Apply it inside
   `getMeta()`'s return value AND `getTitle()` AND `stripHtml()`** — i.e. decode at the
   extraction boundary so titles/descriptions/bodies are clean *before* anything downstream.
   (Decoding only in `stripHtml` — the v1 plan — misses the `og:title` path that caused the
   screenshot.)
2. **Harden IG/FB extraction:** keep free methods; on a social link, treat the extracted
   caption as `body`, never as a verbatim `title`; keep `og:image` as the background source
   (present for IG/FB via ddinstagram/oEmbed; falls to stock SVG if absent — already handled).

**File:** `packages/api/src/routers/repurpose.router.ts`
3. **ALWAYS synthesize a headline for `extracted.type === "social"`** (not only when the title
   "looks generic"). Social captions are structurally unlike article titles, so generate a
   concise headline from the caption via `generateContentResilient` (OpenAI default) before
   rendering.
4. **Mandatory headline truncation** before `buildHeadlineCreative`/`buildStaticCreative`:
   cap at **~80 chars / ~12 words** so the template's word-count font-size logic
   (`news-card-template.ts:214-215`) never renders an oversized caption at an unreadably
   small size. Applies to all formats, not just social.
5. **Graceful block message:** if all extractors fail, the existing `friendlyAIMessage`/toast
   tells the user to paste the text manually (no silent garbage).

### B1. Carousel publish failure — ROOT CAUSE CONFIRMED (2026-06-09)
> **Adversarial review pinpointed this — no longer "investigate".**

**Cause:** Carousel slides are uploaded to S3 (`repurpose.router.ts:939-948`) but **no
`Media` DB rows are created** for them, and `perPlatformMedia` is only populated for the
`static` format (`:476-478`) — for carousel/reel it stays `{}` (`:425`, never set in the
carousel branch `:756-1033`). The returned `mediaMap` is therefore empty for carousels
(`:1063`). The UI reads `mediaIds` from `results.mediaMap` (`RepurposeTab.tsx:878-888`) →
gets an empty set → `post.create` (which expects `mediaIds[]` to build `mediaAttachments`,
`post.router.ts:66,134-141`) creates a post with **no media** → the publish worker finds
nothing to publish → carousel post fails.

**Fix:** In the carousel branch, after each slide uploads to S3, create a `Media` row
(`ctx.prisma.media.create({ url, fileType, organizationId, uploadedById, ... })`), collect
the `mediaId`s **in slide order**, and populate `perPlatformMedia[platform]` for every target
platform with the ordered slide media (carousel needs an ordered array, not a single
`{url,mediaId}`). The `mediaMap`/results shape must carry the **array** of slide mediaIds so
the UI passes all of them to `post.create`. Mirror the static branch's
`uploadAndCreateMedia` helper (which already creates Media rows) for each slide.

**Acceptance:** Generate a carousel → click Post → post.create receives all slide mediaIds in
order → published/created carousel post has every slide attached; no empty-media failure.

---

## Files touched (summary)
**Super Agent:** `app/api/chat/stream/route.ts` (attachments query + real `hasAttachments` +
vision-only fallback set), `chains/chat-agent.chain.ts` (widen `ChatMessage.content` +
multimodal LangChain + Gemini branch), `providers/gemini.provider.ts` (`callGemini` accepts
`Content[]`), `prompts/chat-agent.prompt.ts`, `routers/chat.router.ts` (action `mediaIds`),
`dashboard/super-agent/page.tsx` (merge attachment mediaIds into actions).
**Repurpose:** `tools/news-card-template.ts` (+ 4 new style builders + `buildStaticCreative`),
`tools/news-image-generator.ts`, `utils/url-extractor.ts` (`decodeEntities` in
`getMeta`/`getTitle`/`stripHtml`), `routers/repurpose.router.ts` (carousel Media rows +
ordered `perPlatformMedia` + always-synthesize social headline + truncation + logo/brandColor),
`components/content-agent/RepurposeTab.tsx` (style picker + brand-ref panel + template
dropdown + format relabel/Veo3-disabled), new `routers/creative-template.router.ts`,
`prisma/schema.prisma` (new `CreativeTemplate` + back-relations on Organization/Media/User).
> **NOT touched (corrected):** `providers/dalle.provider.ts` — the v1 `images/edits` plan was
> dropped (impossible on this account). `safe-image-generator.ts` already forwards
> `referenceImages` to Gemini; no change needed there.

## Invariants to preserve
- All chat actions stay plan-gated + `assertChannelsOwned`; `publish_now` stays
  confirm-only (no auto-fire).
- All AI failures route through `friendlyAIMessage` (no leaked project IDs).
- Puppeteer `setContent` stays `waitUntil:"load"`; stock-SVG bg fallback preserved.
- `requirePlan(..., ctx.isSuperAdmin)` for AI video; superadmin bypass intact.
- `gpt-image-1` only (no `dall-e-*`); no `response_format` on `generations`; **no
  `images/edits` call** (dall-e-2-only, account lacks access).
- Brand-reference AI conditioning is **Gemini-only**; logo + brand color are baked
  **deterministically by the template**, so brand shows even when Gemini is on billing hold.
- Vision fallback set is **vision-capable providers only** (openai/anthropic/gemini) when
  attachments are present — never grok/deepseek/gemma4.
- `?tab=`/`?view=` routing contract unchanged.

## Testing
- Unit: `buildStaticCreative` per style (snapshot HTML for known opts); `decodeEntities`
  (named + numeric + hex + emoji); social-link title/body separation.
- Existing regression suites (`chat-action-gating`, `chat-channel-ownership`, `s3-config`)
  must stay green; add `creative-template` ownership test (IDOR guard).
- Live verification per the audit's verification plan + the no-reference path + a saved
  template round-trip.

## Out of scope
- Resolving the Google Cloud billing hold (Veo3 + native Gemini images stay degraded —
  OpenAI fallback covers static/carousel).
- Paid social-scraper integration (chosen against).
- TikTok (India ban, unchanged).
