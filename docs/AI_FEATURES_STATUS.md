# AI Features Status (2026-06-01)

Legend: ✅ wired & works · 🔑 wired but needs an API key set · 🔧 fixed in this change

| Feature | tRPC procedure | Provider / Model | Status |
|---------|---------------|------------------|--------|
| Generate content | `ai.generateContent` | OpenAI `gpt-4o` (default), Anthropic, Gemini, Grok, DeepSeek, Gemma4 | 🔧 default model was stale `gpt-4-turbo` → `gpt-4o` (fixed in Task 2) / 🔑 |
| Suggest hashtags | `ai.suggestHashtags` | same text providers | 🔑 |
| Optimize content | `ai.optimizeContent` | same text providers | 🔑 |
| AI config query | `ai.getConfig` | — (env-key presence check) | ✅ (no key needed) |
| Repurpose content | `repurpose.repurpose` | same text providers | 🔑 |
| Extract URL | `repurpose.extractUrl` | URL scraper (no AI key needed) | ✅ |
| Repurpose from URL | `repurpose.repurposeFromUrl` | text + image (Nano Banana/Gemini) + video (Veo3, Seedance) | 🔑 (video gated to Pro/Enterprise) |
| Image generate | `image.generate` | Nano Banana (Gemini), Nano Banana Pro, DALL·E 3 | 🔑 |
| Image generate (Meta AI) | `image.generate` (provider: `meta-ai`) | Meta AI image API | 🔑 |
| Image edit | `image.edit` | Nano Banana (Gemini) only | 🔑 |

## Wiring verification (2026-06-01)

All paths were traced end-to-end. No dead imports or missing functions were found.

### Path 1 — `ai.router.ts` → text chains

| Router call | Import | Chain file | Provider calls |
|-------------|--------|-----------|----------------|
| `ai.generateContent` | `import("@postautomation/ai").generateContent` | `chains/content-generation.chain.ts` | `getModel()` (LangChain) or `callGemini()` / `callGemma4()` |
| `ai.suggestHashtags` | `import("@postautomation/ai").suggestHashtags` | `chains/hashtag-suggestion.chain.ts` | same |
| `ai.optimizeContent` | `import("@postautomation/ai").optimizeContent` | `chains/schedule-optimization.chain.ts` | same |

All three chains import from `providers/provider.factory.ts` (`getModel`, `isLangChainProvider`),
`providers/gemini.provider.ts` (`callGemini`), and `providers/gemma4.provider.ts` (`callGemma4`).
All four provider files exist and export the referenced symbols.

### Path 2 — `repurpose.router.ts` → `content-repurpose.chain.ts`

`repurpose.repurpose` dynamically imports `repurposeContent` from `@postautomation/ai`, which is
re-exported from `chains/content-repurpose.chain.ts`. Chain uses the same `getModel` / `callGemini`
/ `callGemma4` pattern. ✅

`repurpose.repurposeFromUrl` dynamically imports a larger set of symbols:

| Symbol imported as | Actual export name | Source file |
|--------------------|--------------------|-------------|
| `generateImage` aliased as `generateGeminiImage` | `generateImage` | `providers/nano-banana.provider.ts` (via index) |
| `generateVideo` aliased as `generateVeo3Video` | `generateVideo` | `providers/veo.provider.ts` |
| `generateSeedanceVideo` | same | `providers/seedance.provider.ts` |
| `generateImageSafe` | same | `utils/safe-image-generator.ts` |
| `enforceNoHashtags` | same | `utils/safe-image-generator.ts` |
| `generateReelVideo` | same | `tools/reel-generator.ts` |
| `overlayLogoOnImage` | same | `tools/news-image-generator.ts` |
| `generateSpeech`, `generateVoiceOverScript` | same | `providers/tts.provider.ts` |
| `extractUrlContent`, `repurposeContent`, `generateContent` | same | respective chain/util files |
| `buildVideoPrompt`, `buildSeedancePrompt` | same | veo / seedance providers |

All symbols are exported from `packages/ai/src/index.ts`. ✅

### Path 3 — `image.router.ts` → image providers

Router imports `generateImage`, `editImage`, `generateImageDallE`, `generateImageMeta` directly
(static import) from `@postautomation/ai`. All four are confirmed exported from the package index:

| Function | Provider file |
|----------|--------------|
| `generateImage` | `providers/nano-banana.provider.ts` |
| `editImage` | `providers/nano-banana.provider.ts` |
| `generateImageDallE` | `providers/dalle.provider.ts` |
| `generateImageMeta` | `providers/meta.provider.ts` |

✅

## Type-check & test results

- **`pnpm type-check` (root / turbo):** 7/7 packages successful, all cached (0 errors).
- **`pnpm --filter @postautomation/ai test`:** 122 tests across 6 files — all passed (604 ms).

## Required env keys per provider

| Provider | Key(s) |
|----------|--------|
| OpenAI (default text + DALL·E) | `OPENAI_API_KEY` · optional `OPENAI_MODEL` override |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google (Gemini, Gemma4, Nano Banana, Veo3) | `GOOGLE_GEMINI_API_KEY` or `GOOGLE_AI_API_KEY` |
| xAI (Grok) | `XAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Together AI (FLUX.1 / Seedance) | `TOGETHER_API_KEY` |
| fal.ai (Seedance video) | `FAL_KEY` or `FAL_API_KEY` |
| Meta AI (image) | `META_AI_API_KEY` |

> **Note:** `ai.getConfig` exposes which providers are configured so the UI can hide
> unconfigured provider buttons without making a failing API call.

## Notes

- The only code defect found in this audit was the stale default model `gpt-4-turbo` in
  `packages/ai/src/providers/openai.provider.ts`, already fixed in Task 2 (→ `gpt-4o`).
- All other failures at runtime are **configuration** (missing API key), not code bugs.
- `repurpose.repurposeFromUrl` aliases `generateImage` → `generateGeminiImage` locally
  inside the router; this is intentional (avoids name collision with the `generateImage`
  helper used for carousel slides) and resolves correctly.
- Video generation (`ai_video` / `seedance_video` formats) is plan-gated to
  Professional and Enterprise orgs; FREE/STARTER requests are rejected with `FORBIDDEN`
  before any provider call is made.
