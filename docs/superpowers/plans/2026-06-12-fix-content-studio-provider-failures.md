# Fix Plan — Content Studio AI provider failures, transparency & key inventory

**Date:** 2026-06-12
**Context:** Triage of `Repurpose_Testing.docx` (34 screenshots across format × style × provider). The user asked: are these all "API exhausted"? Answer: **no — five distinct buckets.** This plan fixes the genuine code/UX bugs, documents what's external (billing/keys), and adds provider transparency.

> **Ground truth was verified against PRODUCTION** (`docker exec postautomation-{web,worker}-1 printenv`) + code, on 2026-06-12. This **corrects** an earlier read that used the local `.env` (where FAL/Gemini-image looked "unset"). See §4.

> **VERIFICATION ROUND 2 (2026-06-12, byte-level re-check of every claim):** five corrections were applied to this plan after directly reading each cited file:
> 1. **NEW ROOT CAUSE (A0):** repurpose's `generateContentResilient` ([repurpose.router.ts:786-796](../../../packages/api/src/routers/repurpose.router.ts)) falls back **only to OpenAI** — `if (args.provider === "openai") throw e;` — there is NO Anthropic fallback. Combined with evidence that **OpenAI itself was quota-degraded during the test** (tester: *"only anthropic (claude) works"*; OpenAI rows fail intermittently across the matrix — e.g. image7/image11 show "Repurpose failed" on OpenAI-selected runs), every dead provider funneled into a single degraded target while Anthropic sat healthy and unused. This explains the matrix far better than billing alone.
> 2. `ai.getConfig` **already exists and is complete** (text+image+video, [ai.router.ts](../../../packages/api/src/routers/ai.router.ts) "Single source of truth for all provider-gating UI", commit `520ccfa`, on main). ComposeTab/GenerateTab/ImageTab **already consume it**. Only **RepurposeTab** is ungated. A2 shrinks to a small frontend patch.
> 3. The claimed chat-upload "partial attachment state" bug **does not exist** — `handleFileUpload` ([super-agent/page.tsx:223-240](../../../apps/web/app/dashboard/super-agent/page.tsx)) only pushes on success and surfaces failure as a system chat message. A3 is rescoped to an ops check. The "UI distorted" screenshot (image31) is consistent with browser zoom-out, not a layout bug.
> 4. `SafeImageResult` **already carries `source`** (`"gemini" | "gemini-sanitized" | "gemini-generic" | "dalle"`, [safe-image-generator.ts:36-41](../../../packages/ai/src/utils/safe-image-generator.ts)) — B1's image half is threading existing data to the UI, not new plumbing.
> 5. Smart-router path corrected: `packages/ai/src/routing/smart-router.ts` (not `lib/`). The single-fallback claim in the chat route is **confirmed verbatim** ([stream/route.ts:259](../../../apps/web/app/api/chat/stream/route.ts): `FALLBACK_PRIORITY.find((p) => p !== provider)` — comment says "max 1 fallback").

---

## 0. The Seedance question — "if FAL_KEY was never set, how did AI video ever work?"

**It WAS set, and it DID work.** The earlier "FAL_KEY never set" claim was wrong — it read the **local** `.env` (where `FAL_KEY` is absent). In **production**, `FAL_KEY` is SET (len 69) in **both** the web and worker containers (verified). Proof it works: **screenshot image29** (AI Video + Anthropic) shows the live activity log *"Generating AI video with Seedance 2.0 (30s-3 min)…"* with 6 scenes queued — i.e. the FAL pipeline ran fine.

So why is "AI Video … failing" written next to OpenAI/Gemini/Grok/DeepSeek/Gemma4 in the doc? Because the `seedance_video` branch ([repurpose.router.ts:1516-1582](../../../packages/api/src/routers/repurpose.router.ts)) first calls **`generateContentResilient` for the text key-points** using the **user-selected text provider**, *then* enqueues the FAL job. When the selected text provider is dead (Grok/DeepSeek = no key; Gemini = billing hold), the **text step** is what the tester saw fail — not FAL. With a healthy text provider (Claude, image29) the whole thing runs. **Nothing about Seedance/FAL is broken.**

---

## 1. Classification of every observed failure (verdict: NOT all "exhausted")

| # | Observed in doc | True root cause | Bucket | Code fix? |
|---|---|---|---|---|
| 1 | Every creative used the blurry **article photo**, never an AI background (static/carousel/reel) | Gemini/Nano-Banana **image** API on the Google Cloud **billing/dunning hold** (project `518560861182`) → OpenAI `gpt-image-1` fallback also erroring (no image credit/access) → router silently swaps in the article photo | **External billing** | No |
| 2 | **Image Studio** "Generation failed (billing or permission)" | Same as #1, but Image Studio has **no** article-photo failsafe, so the billing 403 surfaces directly | **External billing** | No |
| 3 | **Gemini** & **Gemma 4** *text* "failing" | Both read `GOOGLE_GEMINI_API_KEY` → same billing-held Google project → 403 PERMISSION_DENIED (the key exists; billing is suspended) | **External billing** | No |
| 4 | **Grok** & **DeepSeek** *text* "failing" | `XAI_API_KEY` and `DEEPSEEK_API_KEY` are **EMPTY/ABSENT in prod** — never configured. Providers throw "API key not found" **synchronously**, before any network call → NOT exhaustion | **Unconfigured key** + **UI gap** | **Yes (UI gate)** |
| 5 | **Meta AI (FLUX.1)** in Image Studio | `TOGETHER_API_KEY` is **EMPTY/ABSENT in prod** — never configured | **Unconfigured key** + **UI gap** | **Yes (UI gate)** |
| 6 | **AI Video (Seedance)** "failing" next to dead text providers | FAL is **fine**; the **text key-points step** failed on the dead selected provider (see §0) | **External billing / unconfigured (text only)** | Indirect (fixed by #4 gate) |
| 7 | **Super Agent chat** "All providers failed" | **Genuine code bug:** [chat/stream/route.ts:259](../../../apps/web/app/api/chat/stream/route.ts) tries only **one** fallback (`.find()`), and the smart router routes to dead providers (gemini/grok/deepseek). Trips even when OpenAI/Anthropic are healthy | **Code bug** | **Yes** |
| 8 | "**UI distorted** + chat **file upload not showing**" | Upload route has **zero** AI dependency → config-side failure (S3/MinIO/nginx). *Verified round 2:* the front-end handler is already correct (pushes only on success, surfaces the error); "distorted" screenshot consistent with browser zoom | **Config (ops check)** | No (optional toast) |
| 9 | "**New Post** button not redirecting" | UI handler missing the `compose` case | **Code bug — ALREADY FIXED** (commit `dc5a887`) | Done |
| 10 | Captions succeed while every image is the article photo | The **failsafe working as designed** (AI bg → article photo → branded gradient) | **Expected behavior** | No (UX polish only) |

**Net (post-verification):** external billing affects BOTH cloud accounts (Google project hold + **likely OpenAI quota** — see §3.1), three keys were never configured, and **three real code bugs** stand: **A0** (repurpose falls back ONLY to OpenAI — never Anthropic), **A1** (chat tries exactly one fallback), **A2** (RepurposeTab is the one provider picker that never got the `getConfig` gate). The two fallback bugs (A0/A1) are what turned two degraded accounts into matrix-wide failures while a healthy Anthropic sat unused.

---

## 2. The fixes

### Priority A — genuine code bugs (ship these)

#### A0. Repurpose text fallback: fall back through a CHAIN, not OpenAI-only (NEW — highest impact)
**File:** [repurpose.router.ts:786-796](../../../packages/api/src/routers/repurpose.router.ts) (`generateContentResilient`, and check `repurposeContentResilient` for the same pattern).
**Now:** any provider failure retries **OpenAI only**; if the user picked OpenAI, it throws immediately. Anthropic — the one provider that was healthy throughout the test — is never tried.
**Fix:** fall back through `[chosen, "openai", "anthropic"]` (dedup, skip unconfigured via the same env checks `getConfig` uses), throwing only after the chain is exhausted. Keep the existing console.warn per hop. This single change would have turned most of the testing matrix green.
**Test:** unit-test the wrapper: chosen=gemini dead + openai dead + anthropic healthy → returns anthropic result; all dead → throws the LAST error.

#### A1. Super Agent chat: try the FULL fallback chain, not just one (#7)
**File:** [apps/web/app/api/chat/stream/route.ts](../../../apps/web/app/api/chat/stream/route.ts) (~L259-267)
**Now:** `FALLBACK_PRIORITY.find((p) => p !== provider)` — exactly **one** alternative; if it's also dead → "All providers failed".
**Fix:** iterate the whole chain, skipping the already-tried primary, and only throw after **all** are exhausted:
```ts
const chain = [provider, ...FALLBACK_PRIORITY.filter((p) => p !== provider)];
let lastErr: unknown;
for (const p of chain) {
  try { /* attempt stream with p */ return; }
  catch (e) { lastErr = e; continue; }
}
throw new Error("All providers failed"); // only after the whole chain
```
**Also:** in the smart router ([packages/ai/src/routing/smart-router.ts](../../../packages/ai/src/routing/smart-router.ts) — note: `routing/`, not `lib/`) gate routing so it never *selects* a provider whose key is unset — fall through to the next healthy one. (Verified: `classifyWithLLM` already returns `null` quietly on failure — its `callGemini` is wrapped in try/catch with a 2s timeout — so only the keyword/niche/attachment rules need the configured-check.)
**Test:** extend the chat fallback test to assert that with primary + first-fallback both throwing, a third healthy provider still succeeds, and "All providers failed" only fires when every provider errors.

#### A2. Gate the RepurposeTab provider picker (#4, #5) — *rescoped after verification*
**Verified state:** `ai.getConfig` already exists, already covers ALL providers (text/image/video), and ComposeTab / GenerateTab / ImageTab **already gate on it** (commit `520ccfa`). The only ungated picker is **RepurposeTab**.
- **Fix:** in [RepurposeTab.tsx](../../../apps/web/components/content-agent/RepurposeTab.tsx) (hard-coded `providers` const at ~L56, `<SelectContent>` at ~L1151-1163): consume `trpc.ai.getConfig.useQuery()` and replicate the **exact GenerateTab pattern** (GenerateTab.tsx L51-65 + L165-168: `{ value, label, configured: aiConfig?.x }`, disable unconfigured items, auto-select the first configured provider). No backend change needed.
- **Result:** Grok/DeepSeek become visibly "Not configured" instead of silently throwing — no false "failing".

#### A3. Chat file-upload — *rescoped after verification: ops check, not a code bug*
**Verified state:** `handleFileUpload` ([super-agent/page.tsx:223-240](../../../apps/web/app/dashboard/super-agent/page.tsx)) is already correct — it pushes the attachment **only on success** and surfaces failure as a system chat message ("Upload failed: …"). There is no partial-state bug. The "UI distorted" screenshot (image31) is consistent with browser zoom-out, not a CSS defect.
- **Action (ops):** reproduce the upload failure in prod and read the `[upload]`-prefixed logs (CLAUDE.md quirk #8) — expected causes: S3 keys/bucket, or nginx body-size limit on the upload route. Fix is config-side.
- **Optional polish:** also fire a toast on upload failure (the system-message error can scroll out of view), so the failure is unmissable.

### Priority B — transparency (the user's explicit ask: "it must be apparent which models are being used at all times")

#### B1. Show the *actual* model used, everywhere in Content Studio
Today the UI shows the **chosen** provider, but on fallback the *actual* provider/model differs silently (e.g. you pick Gemini, OpenAI answers). Make the truth visible.
- **Backend:** `generateImageSafe` **already returns** `source: "gemini" | "gemini-sanitized" | "gemini-generic" | "dalle"` ([safe-image-generator.ts:36-41](../../../packages/ai/src/utils/safe-image-generator.ts)) — the data exists; thread it into the repurpose progress events + mutation result, and have the **router** add the two fallback values it alone knows about (`"article-photo"` / `"gradient"`, set where it catches the AI failure at repurpose.router.ts:451-468). For text, the A0 chain-wrapper should report which provider served (a mutation-scoped variable surfaced in the result + a progress line on each fallback hop — `generateContentResilient` currently returns a bare `Promise<string>`; don't change its return type, track via closure).
- **Frontend — surface it:**
  - **Repurpose activity log:** add a step like *"Caption generated · OpenAI (gpt-4o)"* and *"Background: article photo (AI image unavailable)"* / *"Background: Nano Banana"*. This directly answers "which model rendered this".
  - **Generated preview cards** (static/carousel/reel): a small caption-line under the image: *"AI background"* vs *"Article photo (AI unavailable)"* vs *"Branded gradient"* — turns the silent failsafe (#10) into an honest label.
  - **Image Studio & Generate tab:** show *"Generated by {model}"* on the result.
  - **Super Agent:** show the model badge on each assistant message (it routes dynamically — users should see "answered by Claude" vs "GPT-4o").
- **Why:** makes #1/#10 self-explanatory ("oh, the AI background was unavailable so it used the article photo") and removes the mystery of fallback.

### Priority C — UX polish (optional, recommended)

#### C1. Make the silent article-photo swap visible (#1, #10)
Folded into B1's preview label. Also add a one-line inline notice in the repurpose result when `servedBy` is a fallback, mirroring Image Studio's honest toast — so operators know the AI background didn't render (vs thinking the blurry photo *is* the AI output).

---

## 3. Operational actions (NOT code — must be done in consoles)

These fix the *external* buckets. No deploy helps until these are resolved:

1. **OpenAI account credit/quota — CHECK FIRST** (elevated after verification round 2). The test evidence says OpenAI was **intermittently failing for text too** (tester: *"only anthropic (claude) works"*; OpenAI-selected runs show "Repurpose failed" in image1/7/11/14/20) and consistently failing for images. An `insufficient_quota` on the OpenAI account explains both, and because BOTH fallback chains target OpenAI (A0/A1), it amplified into matrix-wide failures. Top up / verify billing at platform.openai.com → unblocks most of the matrix immediately, even before code fixes.
2. **Google Cloud billing/dunning hold — project `518560861182`** (owner `admin@dashmani.com`). This single hold kills: Gemini text, Gemma 4 text, Nano Banana images, Veo3 video. Clear the dunning/billing in Cloud Console. → unblocks #1 (Gemini half), #2, #3.
3. **Optional: set the unconfigured keys** only if those providers are wanted:
   - `XAI_API_KEY` (Grok), `DEEPSEEK_API_KEY` (DeepSeek), `TOGETHER_API_KEY` (Meta AI / FLUX.1).
   - If NOT wanted, leave them unset — the A2 UI gate will hide them cleanly. **Recommendation:** decide per-provider; don't pay for providers you won't use. OpenAI + Anthropic + Gemini (once billing clears) is a complete set.

---

## 4. Definitive key & billing inventory (verified in PRODUCTION 2026-06-12)

`docker exec postautomation-{web,worker}-1 printenv` + provider→key mapping from `packages/ai/src/providers/*.ts`.

| AI option (UI) | Env var read | Prod state | Working? | Why |
|---|---|---|---|---|
| **OpenAI (GPT-4)** text | `OPENAI_API_KEY` | ✅ SET | ⚠️ **Intermittent** | Worked in some runs, failed in others (image1/7/11/14/20 show "Repurpose failed" on OpenAI-selected runs; tester: "only claude works") — consistent with **quota degradation**. Verify billing FIRST (§3.1) |
| **Anthropic (Claude)** text | `ANTHROPIC_API_KEY` | ✅ SET | ✅ Working | The provider that worked across the doc |
| **Google (Gemini)** text | `GOOGLE_GEMINI_API_KEY` | ✅ SET | ❌ Failing | **Billing hold** on Google project (key present, billing suspended) |
| **Google (Gemma 4)** text | `GOOGLE_GEMINI_API_KEY` (shared) | ✅ SET | ❌ Failing | Same billing-held project as Gemini |
| **xAI (Grok)** text | `XAI_API_KEY` | ❌ EMPTY/ABSENT | ❌ Failing | **Never configured** (synchronous "key not found") — NOT exhausted |
| **DeepSeek** text | `DEEPSEEK_API_KEY` | ❌ EMPTY/ABSENT | ❌ Failing | **Never configured** — NOT exhausted |
| **Nano Banana / NB Pro** image | `GOOGLE_GEMINI_API_KEY` | ✅ SET | ❌ Failing | **Billing hold** (image API on the held project) |
| **DALL-E 3 / gpt-image-1** image | `OPENAI_API_KEY` | ✅ SET (text works) | ❌ Failing | OpenAI **image** path: needs `gpt-image-1` access + image credit — verify quota (`insufficient_quota`) |
| **Meta AI (FLUX.1)** image | `TOGETHER_API_KEY` | ❌ EMPTY/ABSENT | ❌ Failing | **Never configured** — NOT exhausted |
| **AI Video (Seedance)** | `FAL_KEY` | ✅ SET (len 69, web+worker) | ✅ **Working** | image29 shows it running — text key-points step is the only thing that can fail (on a dead text provider) |
| **AI Video (Veo3)** | `GOOGLE_GEMINI_API_KEY` | ✅ SET | ⛔ Intentionally disabled | UI shows "Temporarily unavailable" pending the billing hold |

**Summary:**
- **Ran out of usage / billing-held:** the **Google Cloud project** (`518560861182`) — affects Gemini text, Gemma 4, Nano Banana images, Veo3. Plus likely the **OpenAI image** quota (verify). These are the only "exhausted/suspended" items.
- **Keys never set (NOT exhausted):** `XAI_API_KEY` (Grok), `DEEPSEEK_API_KEY` (DeepSeek), `TOGETHER_API_KEY` (Meta AI/FLUX.1).
- **Fully healthy:** OpenAI text, Anthropic text, **FAL/Seedance video**.

---

## 5. Files to touch (code work)

| File | Change | Issue |
|---|---|---|
| `packages/api/src/routers/repurpose.router.ts` | **A0:** `generateContentResilient` falls back through `[chosen → openai → anthropic]` (configured-only), not OpenAI-only | A0 |
| `apps/web/app/api/chat/stream/route.ts` | full-chain fallback loop (not single `.find()`, verified at L259) | A1 |
| `packages/ai/src/routing/smart-router.ts` | skip-unconfigured providers when routing (path corrected: `routing/`, not `lib/`) | A1 |
| `apps/web/components/content-agent/RepurposeTab.tsx` | gate provider `<Select>` via `ai.getConfig` (replicate GenerateTab L51-65/L165-168 pattern) — the ONLY ungated tab | A2 |
| `packages/api/src/routers/repurpose.router.ts` | thread existing `SafeImageResult.source` + router-known `article-photo`/`gradient` into progress events + result | B1, C1 |
| `apps/web/components/content-agent/RepurposeTab.tsx` (preview) | show "AI background / article photo / gradient" label + caption-provider line | B1, C1 |
| `apps/web/app/dashboard/super-agent/page.tsx` | model badge per assistant message (+ optional upload-failure toast) | B1, A3-polish |

**Removed from the original plan after verification:** `ai.router.ts getConfig` changes (already complete), GenerateTab/ImageTab gating (already gated, commit `520ccfa`), upload-route/state-cleanup changes (no bug exists — ops check instead), `safe-image-generator.ts` return-shape change (`source` already exists).

## 6. What this deliberately does NOT change (no-sabotage guardrails)
- The **failsafe chain** (AI image → article photo → branded gradient). We make it **visible**, not removed — creatives must always render.
- The **published caption** path, the **font/cap** logic, security sanitizers, SSRF guards.
- Stripe/billing gates (already disabled via `BILLING_DISABLED`).
- No new provider keys are committed; setting them is an operational decision (§3.3).

## 7. Verification
1. `pnpm --filter @postautomation/api test` + `pnpm --filter @postautomation/web exec tsc --noEmit` — green.
2. New tests: chat full-chain fallback; upload-failure state cleanup; `getConfig` lists all providers with correct `configured`.
3. Manual (prod): a) Super Agent with Gemini-routed prompt still answers via OpenAI/Anthropic (no "All providers failed"); b) RepurposeTab shows Grok/DeepSeek as "Not configured"; c) a repurpose result labels its background source; d) chat upload failure shows a toast and leaves the composer layout intact.
4. After §3.1/§3.2 (billing) clears: re-run the repurpose matrix — AI backgrounds should render (not article photos), Image Studio succeeds, Gemini/Gemma text works.
