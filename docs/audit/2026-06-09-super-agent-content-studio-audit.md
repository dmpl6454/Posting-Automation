# Audit: Super Agent + Content Studio (Repurpose) — 2026-06-09

End-to-end audit of the two modules the user reported broken. Each finding lists the
**symptom**, the **root cause** (file:line), and the **fix direction**. Severity:
🔴 broken/unusable · 🟠 degraded/ugly · 🟡 confusing/missing feature.

---

## MODULE A — Super Agent (chat assistant)

### A1 🔴 Uploaded/selected media is invisible to the agent
**Symptom:** Upload a file or pick from Media Library, ask "what is this image?" → agent
replies "please describe the image." "Post this" → "please provide the content."

**Root cause:** The attachment round-trips to the DB but never reaches the model.
- UI `handleSend` correctly sends `attachmentMediaIds` → `chat.sendMessage` persists them
  (`chat.router.ts:182` creates `ChatMessageAttachment` rows). ✅
- BUT the streaming route `apps/web/app/api/chat/stream/route.ts` loads history with
  `select: { role, content, metadata }` — **the `attachments` relation is dropped**, and
  it passes `hasAttachments: false` (hardcoded) to `routeProvider`.
- `streamChatAgent` only ever sends `m.content` (text) as `HumanMessage` — **no image
  parts are ever attached** to the LLM call.
- Net: the model never receives the image bytes → cannot "see" or "post" it.

**Fix direction:** In the stream route, load `attachments → media` for each message; for
messages that have image attachments, build a multimodal `HumanMessage` (text + image_url
data parts). Pass `hasAttachments` truthfully so the smart router picks a vision-capable
model. The agent must be able to (a) describe an uploaded image and (b) attach the
uploaded `mediaId` to `publish_now`/`schedule_post` actions.

### A2 🟠 `publish_now`/`schedule_post` from chat can't carry the uploaded media
**Symptom:** Even once the model "sees" the image, the action payload has no way to
reference the just-uploaded media → a published post would have no image.

**Root cause:** `executeAction` `schedule_post`/`publish_now` build post targets from
`p.channelIds` + `content` only. There is no `mediaIds` passed from the attachment set.

**Fix direction:** Thread the message's attachment `mediaId`s into the action payload
(client includes them in the executed action; server attaches them to the created post's
media). Keep `assertChannelsOwned` + plan gating intact.

### A3 🟡 System prompt never tells the agent it can see/use attachments
**Root cause:** `chat-agent.prompt.ts` lists actions but says nothing about images the
user attaches, so even with vision wired the agent won't reliably use them.

**Fix direction:** Add a short "ATTACHED MEDIA" section to the prompt: when the user
attaches an image, you can describe it, and when they say "post this," attach it.

---

## MODULE B — Content Studio · Repurpose

### B1 🔴 Carousel post button exists but publishing fails
**Symptom:** Carousel generates slides, but the "Post" action fails.
**Status:** NEEDS LIVE REPRO to capture the exact error — likely the post-create path
rejecting a multi-image media array, or a platform that doesn't accept carousels in the
selected targets. To be confirmed during verification with the dev server + a real
generate→post run. (Tracked as a verification task, not assumed.)

### B2 🟠 Static post is ugly (and so is the carousel cover — same renderer)
**Symptom:** Static posts (and the carousel's first slide) render as a dark photo with a
small headline + tiny footer. Looks unbranded/low-effort (see user screenshot).

**Root cause:** `generateStaticNewsCreativeHtml` (`news-card-template.ts`) is a minimal
template: full-bleed dark photo, one accent rule, headline bottom-left, 110px footer with
logo + name. No real layout system, weak typographic hierarchy, no brand theming beyond a
single accent color. The carousel cover deliberately reuses it (`repurpose.router.ts:882`).

**Fix direction:** Redesign the static-creative template into a polished, modern social
creative (stronger hierarchy, gradient scrims, better type scale, optional brand colors,
proper safe-area). Because the carousel cover calls the same `buildHeadlineCreative`,
fixing this fixes the cover too.

### B3 🟡 Carousel's first slide is always "static format"
**Root cause:** Intentional — `repurpose.router.ts:882` routes the `cover` slide through
`buildHeadlineCreative` (the static renderer) so branding is consistent. The complaint is
really B2 (the renderer is ugly). Once B2 is redesigned, the cover inherits it. Optionally
give the cover a distinct "cover" variant of the new template.

### B4 🟡 Missing: reference/brand images to mimic a channel's brand
**Symptom:** No way to give the generator a logo / brand reference so output matches a
channel's look (logo placement top-left/right, brand palette, style inspiration).

**Root cause:** The capability is **half-built**: `nano-banana.provider` accepts
`referenceImages` and `safe-image-generator` forwards them — but the repurpose router and
UI never collect or pass any reference images. The OpenAI fallback (`gpt-image-1` via the
`generations` endpoint) **ignores** reference images entirely (`editImageDallE` discards
the source image).

**Fix direction:** (1) UI: add a "Brand reference images" uploader (logos, sample posts).
(2) Router: pass them as `referenceImages` to `generateImageSafe`, and extract brand color
from the logo for the template accent. (3) OpenAI fallback: use the `images/edits`
endpoint (`gpt-image-1` supports image inputs there) so references work even when Gemini
is on its billing hold. (4) Bake logo into the deterministic template footer/corner per a
chosen position.

### B5 🟡 Seedance 2.0 / Reel-Video purpose is unclear / overlapping
**Observation:** Three video-ish formats exist: `reel` (slideshow stitched from slides +
TTS + bg music — FFmpeg), `ai_video` (Veo3 — **dead**, Google billing hold), `seedance_video`
(ByteDance via fal.ai — working). Veo3 being dead makes the menu confusing; "Reel/Video"
(slideshow) vs "Seedance" (true AI video) overlap in the user's mind.

**Fix direction (product):** Clarify/relabel the format menu — make each format's purpose
explicit, hide or clearly mark Veo3 as unavailable (billing hold), and explain Reel
(slideshow) vs Seedance (AI-generated footage). Confirm with user which to keep/cut.

### B6 🔴 Social-post URLs (Instagram/FB/etc.) fail or produce garbage
**Symptom:** Public news URLs work. An Instagram/FB/Twitter **post** link produces a bad
result — the user's screenshot shows the static creative rendered with raw HTML entities
in the headline (`&quot; &#x1f37f; … &#x2019;s … &#x1f3ac;`) i.e. the caption was taken as
the headline AND not entity-decoded.

**Root cause (two bugs):**
1. **No HTML-entity decoding.** `stripHtml` removes tags but leaves entities
   (`&quot;`, `&#x1f37f;`, `&#x2019;`). The extracted title/body carries raw entities into
   the template → the garbled headline in the screenshot.
2. **Social extractors are brittle / partial.** `extractInstagram` relies on `ddinstagram`
   + `api.instagram.com/oembed` (oEmbed has been **deprecated/locked behind a token** since
   2020) + a direct fetch that IG blocks for data-center IPs. `extractFacebook` relies on
   `facebook.com/plugins/post/oembed.json` (also token-gated now). When all fail, the body
   falls back to the caption/`og:description`, and a whole social caption (with emoji
   entities) becomes the "headline." Carousels/reels from a post link can't pull the real
   media either.

**Fix direction:** (1) Add a robust HTML-entity decoder used by all extractors before text
reaches the template. (2) Harden social extraction (better proxies/fallbacks, sane title
vs body separation, length caps so a caption isn't used as a headline). (3) When a social
link yields only a caption, treat it as *body* and synthesize a proper short headline via
the text model rather than dumping the raw caption into the headline slot.

---

## Shared / cross-cutting
- **Entity decoding** (B6.1) also improves every web-article headline.
- **Brand color extraction** (`extractDominantColor`) already exists — wire it into the new
  template (B2) and reference flow (B4).
- All AI failures already route through `friendlyAIMessage` — keep that; don't leak project IDs.

## Verification plan (live, dev server)
1. Super Agent: upload image → "what is this?" → expect a real description.
2. Super Agent: upload image → "post this to <channel>" → expect a `publish_now`/`schedule`
   action carrying the mediaId; published post has the image.
3. Repurpose static: redesigned creative renders, looks polished, logo placed.
4. Repurpose carousel: cover uses new design; generate → post succeeds (B1 repro+fix).
5. Repurpose with brand reference image: output reflects the brand/logo.
6. Repurpose from an Instagram + a Facebook post link: clean (entity-decoded) headline,
   sensible caption, no raw `&quot;`/emoji-entity garbage.
