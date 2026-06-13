# Repurpose Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **➕ CARRIED IN FROM PLAN 1 (2026-06-13):** the schedule-time media-required block (originally Plan 1 Tasks 2–4) is deferred here. Once the real-first / AI-opt-in toggle (D2) exists, wire `mediaRequiredBlock` (already built in Plan 1 Task 1, `packages/api/src/lib/media-required.ts`) into `post.router.create` and the chat `schedule_post`/`bulk_schedule`/`publish_now` paths — but pass the **real** `aiEnabled` value from the toggle, not hardcoded `false`. Reason: the publish worker auto-generates an AI image for media-less IG/FB unconditionally today, so a block must only fire when the user has actually turned AI off. Add the org-scoped `assertMediaForPlatforms` helper (runs AFTER `assertChannelsOwned`) + its IDOR regression tests at that point.

**Goal:** Wire the composable-card engine (built by Plan 2) into the user-facing Repurpose feature end-to-end: structured template auto-detection, a real-first per-slot image resolver with custom-image-per-slot for all formats, consistent carousel cover/body rendering, a saved-styles library backed by an extended `CreativeTemplate`, and a rebuilt `RepurposeTab` UI with honest source labels.

**Architecture:** A new `packages/ai/src/tools/classify-card.ts` adds structured gpt-4o-mini vision detection returning a `CardHint`. A new `packages/ai/src/tools/image-slot-resolver.ts` adds a pure `resolveImageSlot` real-first ladder. `repurpose.router.ts` calls these plus the Plan-2 `renderCard`, accepts per-slot `imageAssignments` (org-scoped via `assertMediaOwned`) for every format, and persists/reuses resolved `CardSpec`s through an extended `creativeTemplate` router. `RepurposeTab.tsx` exposes the Real⇄AI toggle, per-slot image pickers, a per-pill text panel, a Saved-styles gallery, and honest per-slot source chips.

**Tech Stack:** pnpm + Turborepo, TypeScript strict, tRPC + zod, Prisma (Postgres), Next.js (RepurposeTab), Vitest. Image gen via `generateImageSafe` (Gemini→OpenAI). Vision via OpenAI gpt-4o-mini.

---

## Files

| File | Create/Modify | Responsibility |
|---|---|---|
| `packages/ai/src/tools/classify-card.ts` | Create | `classifyCard(imageBase64, mime) → CardHint \| null` structured vision detection (Component 3) |
| `packages/ai/src/__tests__/classify-card.test.ts` | Create | Unit tests for `classifyCard` parsing, sanitization, low-confidence/failure fallback |
| `packages/ai/src/tools/image-slot-resolver.ts` | Create | `resolveImageSlot(slot, ctx) → {url, source}` pure real-first ladder (Component 4 / D10) |
| `packages/ai/src/__tests__/image-slot-resolver.test.ts` | Create | Unit tests for the full fallback matrix + source labels |
| `packages/ai/src/index.ts` | Modify (after line 38) | Re-export `classifyCard`, `CardHint`, `resolveImageSlot`, `ImageSlot` |
| `packages/db/prisma/schema.prisma` | Modify (lines 903–920) | Add `referenceMediaId`, `referenceMedia`, `cardSpec Json?`, `sourceUrl` to `CreativeTemplate`; add `referenceTemplates` back-relation on `Media` |
| `packages/db/prisma/migrations/<ts>_add_cardspec_to_creative_template/migration.sql` | Create (via `prisma migrate dev`) | DB migration for the 3 new columns |
| `packages/api/src/routers/creative-template.router.ts` | Modify (lines 24–103) | Extend `create`/`update` to persist `cardSpec`/`referenceMediaId`/`sourceUrl`; `list`/`getById` re-sanitize stored `cardSpec` on read (Component 9 / D8) |
| `packages/api/src/lib/sanitize-card-spec.ts` | Create | `sanitizeCardSpecJson(raw) → CardSpec \| null` — re-validate every color/url in stored JSON before render |
| `packages/api/src/__tests__/creative-template-cardspec.test.ts` | Create | Tests: stored `cardSpec` re-sanitized on read; tampered color/url rejected; cross-org IDOR blocked |
| `packages/api/src/routers/repurpose.router.ts` | Modify (input schema ~705–719, branches ~1185–1230, ~1778–1830) | Add `imageAssignments` per-slot input + `aiImages` toggle; resolve via `resolveImageSlot`; classify+persist new references; call engine `renderCard` via `buildHeadlineCreative`; per-slot `assertMediaOwned` |
| `packages/api/src/__tests__/repurpose-image-assignments.test.ts` | Create | Tests: per-slot resolution for static + carousel, IDOR guard, source labels |
| `apps/web/components/content-agent/RepurposeTab.tsx` | Modify (state ~141–168, controls ~720–970, create-drafts ~1474–1590) | Real⇄AI toggle, per-slot image picker (all formats), per-pill text panel, Saved-styles gallery, honest source chips, remove dead controls |

---

### Task 1: Extend `CreativeTemplate` schema + migration (Component 9 / D8)

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (lines 903–920 model, line 355 `Media` relation list)
- Create: `packages/db/prisma/migrations/<ts>_add_cardspec_to_creative_template/migration.sql` (generated)
- Test: manual `prisma validate` + `prisma migrate dev` (schema has no vitest suite)

- [ ] **Step 1: Add the 3 new fields + back-relation to the schema.** In `packages/db/prisma/schema.prisma`, replace the `CreativeTemplate` model body (lines 903–920) with:
```prisma
model CreativeTemplate {
  id             String       @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name           String
  style          String // "premium_editorial" | "hook_bars" | "tweet_card" | "bold_typographic"
  logoMediaId    String?
  logoMedia      Media?       @relation("CreativeTemplateLogo", fields: [logoMediaId], references: [id], onDelete: SetNull)
  logoPosition   String       @default("top-right")
  brandColor     String?
  channelId      String?
  // Saved style-reference library (Component 9 / D8)
  referenceMediaId String?
  referenceMedia   Media?     @relation("CreativeTemplateReference", fields: [referenceMediaId], references: [id], onDelete: SetNull)
  cardSpec         Json?      // resolved CardSpec (preset + blocks + StyleControls)
  sourceUrl        String?    // original ref URL, if pasted (sanitized; provenance only)
  createdById    String
  createdBy      User         @relation(fields: [createdById], references: [id])
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@index([organizationId])
}
```
- [ ] **Step 2: Update the `Media` model's `CreativeTemplate` back-relation (line 355).** The existing single relation `creativeTemplates CreativeTemplate[]` is now ambiguous (two relations point at `Media`). Replace line 355 with the two named back-relations:
```prisma
  creativeTemplates          CreativeTemplate[] @relation("CreativeTemplateLogo")
  referenceTemplates         CreativeTemplate[] @relation("CreativeTemplateReference")
```
- [ ] **Step 3: Validate the schema.** Run:
```bash
pnpm --filter @postautomation/db exec prisma validate
```
Expected output: `The schema at packages/db/prisma/schema.prisma is valid 🚀`. If it errors about a missing relation name on `logoMedia`, confirm the `@relation("CreativeTemplateLogo")` was added on BOTH sides.
- [ ] **Step 4: Generate the migration + client.** Run (local Postgres on 5433 must be up — `docker compose up -d`):
```bash
pnpm --filter @postautomation/db exec prisma migrate dev --name add_cardspec_to_creative_template
```
Expected output: `The following migration(s) have been created and applied ... add_cardspec_to_creative_template` then `✔ Generated Prisma Client`. A new `migration.sql` adds 3 nullable columns `referenceMediaId`, `cardSpec`, `sourceUrl` (no data loss — all nullable).
- [ ] **Step 5: Commit.**
```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(repurpose): extend CreativeTemplate with cardSpec/referenceMedia/sourceUrl

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `resolveImageSlot` real-first ladder (Component 4 / D10)

**Files:**
- Create: `packages/ai/src/tools/image-slot-resolver.ts`
- Create test: `packages/ai/src/__tests__/image-slot-resolver.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/image-slot-resolver.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { resolveImageSlot } from "../tools/image-slot-resolver";

const baseCtx = () => ({
  aiToggle: false,
  userImages: {} as Record<string, { url: string }>,
  articleImages: [] as string[],
  brandGradient: "linear-gradient(135deg,#e11d48,#11131a)",
  generateAi: vi.fn(async () => "data:image/png;base64,AAA"),
});

describe("resolveImageSlot — real-first ladder", () => {
  it("1) user-assigned image wins over everything", async () => {
    const ctx = { ...baseCtx(), aiToggle: true, userImages: { m1: { url: "https://cdn/u.jpg" } }, articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({ userImageId: "m1" }, ctx);
    expect(r).toEqual({ url: "https://cdn/u.jpg", source: "user" });
    expect(ctx.generateAi).not.toHaveBeenCalled();
  });

  it("2) AI generates when toggle on and no user image", async () => {
    const ctx = { ...baseCtx(), aiToggle: true, articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({}, ctx);
    expect(r.source).toBe("ai");
    expect(r.url).toBe("data:image/png;base64,AAA");
    expect(ctx.generateAi).toHaveBeenCalledTimes(1);
  });

  it("2b) AI failure falls through to article, never throws", async () => {
    const ctx = { ...baseCtx(), aiToggle: true, articleImages: ["https://cdn/a.jpg"], generateAi: vi.fn(async () => { throw new Error("billing hold"); }) };
    const r = await resolveImageSlot({}, ctx);
    expect(r).toEqual({ url: "https://cdn/a.jpg", source: "article" });
  });

  it("3) article image used when AI off", async () => {
    const ctx = { ...baseCtx(), articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({ articleImageUrl: "https://cdn/a.jpg" }, ctx);
    expect(r).toEqual({ url: "https://cdn/a.jpg", source: "article" });
  });

  it("3b) falls back to ctx.articleImages[0] when slot has no articleImageUrl", async () => {
    const ctx = { ...baseCtx(), articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({}, ctx);
    expect(r).toEqual({ url: "https://cdn/a.jpg", source: "article" });
  });

  it("4) branded gradient when nothing else, never blank", async () => {
    const ctx = baseCtx();
    const r = await resolveImageSlot({}, ctx);
    expect(r).toEqual({ url: ctx.brandGradient, source: "branded" });
  });

  it("ignores a userImageId not present in userImages (falls through)", async () => {
    const ctx = { ...baseCtx(), articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({ userImageId: "ghost" }, ctx);
    expect(r.source).toBe("article");
  });
});
```
- [ ] **Step 2: Run the test — expect FAIL (module missing).**
```bash
pnpm -F @postautomation/ai exec vitest run src/__tests__/image-slot-resolver.test.ts
```
Expected: `Failed to resolve import "../tools/image-slot-resolver"` → all tests fail.
- [ ] **Step 3: Implement `image-slot-resolver.ts`.** Create `packages/ai/src/tools/image-slot-resolver.ts`:
```ts
/**
 * Per-slot real-first image resolution ladder (Component 4 / D10).
 * Every image-consuming block (background, circularInset, splitPhotos/photoGrid
 * tile, carousel slide photo) is an ImageSlot resolved INDEPENDENTLY:
 *   1. user-assigned image (upload OR Media Library pick) for THIS slot
 *   2. AI toggle ON → generate (Gemini → OpenAI, via injected generateAi)
 *   3. article og:image / next article image[]
 *   4. clean branded gradient (never blank/broken)
 * Pure (all I/O injected) + exported for unit testing.
 */

export interface ImageSlot {
  /** Caller fills ONE of these (or neither → ladder decides). */
  userImageId?: string;       // org-owned Media id
  articleImageUrl?: string;   // article og:image or images[i]
  /** Optional per-slot AI prompt; resolver passes it to generateAi. */
  aiPrompt?: string;
}

export type ImageSource = "user" | "ai" | "article" | "branded";

export interface ResolveImageSlotCtx {
  aiToggle: boolean;
  userImages: Record<string, { url: string }>;
  articleImages: string[];
  brandGradient: string;
  /** Returns a data: URL (or https) for an AI image, or throws on failure. */
  generateAi: (prompt?: string) => Promise<string>;
}

export async function resolveImageSlot(
  slot: ImageSlot,
  ctx: ResolveImageSlotCtx,
): Promise<{ url: string; source: ImageSource }> {
  // 1) user-assigned image for this slot
  if (slot.userImageId && ctx.userImages[slot.userImageId]) {
    return { url: ctx.userImages[slot.userImageId]!.url, source: "user" };
  }

  // 2) AI generation when the toggle is on
  if (ctx.aiToggle) {
    try {
      const url = await ctx.generateAi(slot.aiPrompt);
      if (url) return { url, source: "ai" };
    } catch (e) {
      // Fall through to real-photo / branded — never throw on a slot.
      console.warn(`[resolveImageSlot] AI failed, falling through:`, (e as Error).message);
    }
  }

  // 3) article photo — the slot's explicit url, else the first article image
  const article = slot.articleImageUrl || ctx.articleImages[0];
  if (article) return { url: article, source: "article" };

  // 4) branded gradient — always renders, never blank
  return { url: ctx.brandGradient, source: "branded" };
}
```
- [ ] **Step 4: Run the test — expect PASS.**
```bash
pnpm -F @postautomation/ai exec vitest run src/__tests__/image-slot-resolver.test.ts
```
Expected: `Test Files 1 passed` · `Tests 7 passed`.
- [ ] **Step 5: Export from the AI package index.** In `packages/ai/src/index.ts`, after line 38 add:
```ts
export { resolveImageSlot } from "./tools/image-slot-resolver";
export type { ImageSlot, ImageSource, ResolveImageSlotCtx } from "./tools/image-slot-resolver";
```
- [ ] **Step 6: Commit.**
```bash
git add packages/ai/src/tools/image-slot-resolver.ts packages/ai/src/__tests__/image-slot-resolver.test.ts packages/ai/src/index.ts
git commit -m "feat(repurpose): resolveImageSlot real-first per-slot image ladder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `classifyCard` structured vision detection (Component 3)

**Files:**
- Create: `packages/ai/src/tools/classify-card.ts`
- Create test: `packages/ai/src/__tests__/classify-card.test.ts`
- Modify: `packages/ai/src/index.ts` (after Task 2 exports)

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/classify-card.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCardHint } from "../tools/classify-card";

describe("parseCardHint — structured vision parsing + sanitization", () => {
  it("parses a well-formed JSON response", () => {
    const raw = JSON.stringify({
      preset: "news_inset",
      blocks: { logo: true, circularInset: 1, labelChip: 1, captionCount: 2 },
      theme: "dark",
      accentColor: "#1e90ff",
      confidence: 0.82,
    });
    const hint = parseCardHint(raw);
    expect(hint).not.toBeNull();
    expect(hint!.preset).toBe("news_inset");
    expect(hint!.blocks.circularInset).toBe(1);
    expect(hint!.theme).toBe("dark");
    expect(hint!.accentColor).toBe("#1e90ff");
    expect(hint!.confidence).toBeCloseTo(0.82);
  });

  it("strips ```json fences before parsing", () => {
    const raw = '```json\n{"preset":"tweet_card","blocks":{"tweetHeader":true},"theme":"light","accentColor":"#000000","confidence":0.9}\n```';
    expect(parseCardHint(raw)!.preset).toBe("tweet_card");
  });

  it("rejects an unknown preset → null (falls back to news_caption at call site)", () => {
    const raw = JSON.stringify({ preset: "totally_made_up", theme: "light", accentColor: "#fff", confidence: 0.9, blocks: {} });
    expect(parseCardHint(raw)).toBeNull();
  });

  it("sanitizes a malicious accentColor to the default", () => {
    const raw = JSON.stringify({ preset: "news_caption", blocks: {}, theme: "light", accentColor: '#fff" onload=alert(1)', confidence: 0.7 });
    expect(parseCardHint(raw)!.accentColor).toBe("#e11d48");
  });

  it("clamps an out-of-range confidence and coerces a bad theme", () => {
    const raw = JSON.stringify({ preset: "news_caption", blocks: {}, theme: "neon", accentColor: "#abc", confidence: 5 });
    const hint = parseCardHint(raw)!;
    expect(hint.confidence).toBe(1);
    expect(hint.theme).toBe("light");
  });

  it("returns null on non-JSON garbage", () => {
    expect(parseCardHint("the image shows a person")).toBeNull();
  });
});
```
- [ ] **Step 2: Run the test — expect FAIL.**
```bash
pnpm -F @postautomation/ai exec vitest run src/__tests__/classify-card.test.ts
```
Expected: `Failed to resolve import "../tools/classify-card"`.
- [ ] **Step 3: Implement `classify-card.ts`.** Create `packages/ai/src/tools/classify-card.ts`:
```ts
/**
 * Structured reference-card classification (Component 3). A gpt-4o-mini vision
 * call returns a CardSpec-shaped HINT: which blocks are present + theme/accent,
 * NOT just a single template id. Used to auto-select a preset + pre-fill controls
 * in the Repurpose UI (locked-with-Edit). Fails graceful → null; the caller
 * defaults to `news_caption` so generation is never blocked.
 *
 * Layout detection only. The prose `describeImageStyle` descriptor still feeds AI
 * photo prompts when AI is on.
 */
import { safeColor } from "./creative-templates";

export type PresetId =
  | "news_caption"
  | "news_inset"
  | "infographic_stats"
  | "marketing_minimal"
  | "tweet_card"
  | "photo_grid"
  | "title_cover"
  | "listicle_body";

const PRESET_IDS: readonly PresetId[] = [
  "news_caption", "news_inset", "infographic_stats", "marketing_minimal",
  "tweet_card", "photo_grid", "title_cover", "listicle_body",
];

export interface CardHint {
  preset: PresetId;
  blocks: {
    logo?: boolean;
    circularInset?: number;
    labelChip?: number;
    tweetHeader?: boolean;
    statCards?: number;
    captionCount?: number;
  };
  theme: "light" | "dark";
  accentColor: string; // #hex, safeColor-sanitized
  confidence: number;  // 0–1
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const countOrUndef = (v: unknown): number | undefined => {
  const n = num(v, -1);
  return n >= 0 ? Math.round(n) : undefined;
};

/** Parse the vision model's text into a sanitized CardHint, or null. Pure + exported for tests. */
export function parseCardHint(raw: string): CardHint | null {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!PRESET_IDS.includes(obj?.preset)) return null;
  const b = obj.blocks ?? {};
  return {
    preset: obj.preset as PresetId,
    blocks: {
      logo: b.logo === true,
      circularInset: countOrUndef(b.circularInset),
      labelChip: countOrUndef(b.labelChip),
      tweetHeader: b.tweetHeader === true,
      statCards: countOrUndef(b.statCards),
      captionCount: countOrUndef(b.captionCount),
    },
    theme: obj.theme === "dark" ? "dark" : "light",
    accentColor: safeColor(typeof obj.accentColor === "string" ? obj.accentColor : undefined),
    confidence: clamp01(num(obj.confidence, 0)),
  };
}

const CLASSIFY_PROMPT = `You are a layout detector for Instagram-style social cards.
Look at the reference image and return ONLY JSON describing its layout:
{
  "preset": one of ["news_caption","news_inset","infographic_stats","marketing_minimal","tweet_card","photo_grid","title_cover","listicle_body"],
  "blocks": { "logo": bool, "circularInset": int count, "labelChip": int count, "tweetHeader": bool, "statCards": int count, "captionCount": int count },
  "theme": "light" or "dark",
  "accentColor": dominant accent as #rrggbb,
  "confidence": 0..1
}
Pick the SINGLE closest preset. Return ONLY the JSON, no prose.`;

/**
 * Classify a reference image to a preset + block hint via gpt-4o-mini vision.
 * Returns null on any failure (missing key, network, unparseable) so the caller
 * defaults to `news_caption` and never blocks generation.
 */
export async function classifyCard(
  imageBase64: string,
  imageMimeType: string,
): Promise<CardHint | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: CLASSIFY_PROMPT },
              { type: "image_url", image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[classifyCard] vision call failed: ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? parseCardHint(text) : null;
  } catch (e) {
    console.warn(`[classifyCard] error:`, (e as Error).message);
    return null;
  }
}
```
- [ ] **Step 4: Run the test — expect PASS.**
```bash
pnpm -F @postautomation/ai exec vitest run src/__tests__/classify-card.test.ts
```
Expected: `Tests 6 passed`.
- [ ] **Step 5: Export from the AI package index.** In `packages/ai/src/index.ts`, after the Task 2 exports add:
```ts
export { classifyCard, parseCardHint } from "./tools/classify-card";
export type { CardHint, PresetId } from "./tools/classify-card";
```
- [ ] **Step 6: Commit.**
```bash
git add packages/ai/src/tools/classify-card.ts packages/ai/src/__tests__/classify-card.test.ts packages/ai/src/index.ts
git commit -m "feat(repurpose): classifyCard structured vision detection + preset fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `sanitizeCardSpecJson` — re-sanitize stored CardSpec on read (Component 9 / §4 security)

**Files:**
- Create: `packages/api/src/lib/sanitize-card-spec.ts`
- Create test: `packages/api/src/__tests__/sanitize-card-spec.test.ts`

> Depends on Plan 2 having exported `safeColor` and `safeImageUrl` from `@postautomation/ai`. This module re-validates a stored `cardSpec` JSON blob so a tampered DB row can never inject CSS/HTML at render time.

- [ ] **Step 1: Write the failing test.** Create `packages/api/src/__tests__/sanitize-card-spec.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { sanitizeCardSpecJson } from "../lib/sanitize-card-spec";

describe("sanitizeCardSpecJson — never trust stored JSON", () => {
  it("returns null for a non-object blob", () => {
    expect(sanitizeCardSpecJson(null)).toBeNull();
    expect(sanitizeCardSpecJson("not json")).toBeNull();
    expect(sanitizeCardSpecJson(42)).toBeNull();
  });

  it("returns null when blocks is not an array", () => {
    expect(sanitizeCardSpecJson({ canvas: { w: 1080, h: 1350 }, controls: {}, blocks: {} })).toBeNull();
  });

  it("forces canvas to 1080x1350 regardless of stored values", () => {
    const spec = sanitizeCardSpecJson({ canvas: { w: 9999, h: 1 }, blocks: [], controls: { theme: "dark", brandColor: "#000", highlightColor: "#fff", bgOpacity: 50, fontFamily: "inter", textAlign: "left", logoPosition: "tr" } });
    expect(spec!.canvas).toEqual({ w: 1080, h: 1350 });
  });

  it("scrubs a malicious brandColor in controls to the default", () => {
    const spec = sanitizeCardSpecJson({ canvas: { w: 1080, h: 1350 }, blocks: [], controls: { theme: "light", brandColor: '#fff" onload=alert(1)', highlightColor: "#abc", bgOpacity: 200, fontFamily: "evil", textAlign: "diagonal", logoPosition: "xx" } });
    expect(spec!.controls.brandColor).toBe("#e11d48");
    expect(spec!.controls.bgOpacity).toBe(100); // clamped
    expect(spec!.controls.fontFamily).toBe("inter"); // enum fallback
    expect(spec!.controls.textAlign).toBe("left"); // enum fallback
    expect(spec!.controls.logoPosition).toBe("tr"); // enum fallback
  });

  it("drops a captionStack pill bg/image-url breakout via re-sanitization", () => {
    const spec = sanitizeCardSpecJson({
      canvas: { w: 1080, h: 1350 },
      controls: { theme: "light", brandColor: "#000", highlightColor: "#fff", bgOpacity: 50, fontFamily: "inter", textAlign: "left", logoPosition: "tr" },
      blocks: [
        { kind: "captionStack", props: { pills: [{ text: "hi", bg: 'red;}</style><script>', bgOpacity: -5 }] } },
        { kind: "background", props: { mode: "photo", imageUrl: "javascript:alert(1)" } },
      ],
    });
    const pill = (spec!.blocks[0] as any).props.pills[0];
    expect(pill.bg).toBe("#e11d48"); // safeColor fallback
    expect(pill.bgOpacity).toBe(0);  // clamped to [0,100]
    const bg = (spec!.blocks[1] as any).props;
    expect(bg.imageUrl).toBeUndefined(); // safeImageUrl rejected → dropped
  });

  it("drops a block with an unknown kind", () => {
    const spec = sanitizeCardSpecJson({
      canvas: { w: 1080, h: 1350 },
      controls: { theme: "light", brandColor: "#000", highlightColor: "#fff", bgOpacity: 50, fontFamily: "inter", textAlign: "left", logoPosition: "tr" },
      blocks: [{ kind: "evil_block", props: {} }, { kind: "footer", props: { text: "Follow" } }],
    });
    expect(spec!.blocks).toHaveLength(1);
    expect((spec!.blocks[0] as any).kind).toBe("footer");
  });
});
```
- [ ] **Step 2: Run the test — expect FAIL.**
```bash
pnpm -F @postautomation/api exec vitest run src/__tests__/sanitize-card-spec.test.ts
```
Expected: `Failed to resolve import "../lib/sanitize-card-spec"`.
- [ ] **Step 3: Implement `sanitize-card-spec.ts`.** Create `packages/api/src/lib/sanitize-card-spec.ts`:
```ts
/**
 * Re-sanitize a stored CardSpec JSON blob before it is rendered (Component 9 /
 * §4). NEVER trust a stored CreativeTemplate.cardSpec row — every color/url/enum
 * is re-validated through the SAME guards the renderer uses (`safeColor`,
 * `safeImageUrl`). A tampered DB row (manual edit, future bug) therefore cannot
 * inject CSS/HTML at render time. Returns null for a structurally-invalid blob
 * so the caller falls back to a fresh preset rather than rendering garbage.
 */
import { safeColor, safeImageUrl } from "@postautomation/ai";

const DEFAULT_ACCENT = "#e11d48";
const KNOWN_BLOCKS = new Set([
  "background", "logo", "circularInset", "labelChip", "tweetHeader",
  "captionStack", "statCards", "bodyText", "footer", "carouselChrome", "ctaCard",
]);
const FONTS = new Set(["inter", "serif_display", "condensed"]);
const ALIGNS = new Set(["left", "center"]);
const LOGO_POS = new Set(["tl", "tr", "bl", "br"]);

const clampOpacity = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100;

/** Recursively re-sanitize known color/url/opacity props on a block's props object. */
function sanitizeBlockProps(props: any): any {
  if (!props || typeof props !== "object") return props;
  const out: any = Array.isArray(props) ? [...props] : { ...props };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (Array.isArray(v)) {
      out[key] = v.map((item) => sanitizeBlockProps(item));
    } else if (v && typeof v === "object") {
      out[key] = sanitizeBlockProps(v);
    } else if (typeof v === "string") {
      // Color-ish keys → safeColor; url-ish keys → safeImageUrl (drop if rejected).
      if (/color$/i.test(key) || key === "bg") {
        out[key] = safeColor(v);
      } else if (/url$/i.test(key) || /^(src|imageUrl|resolvedUrl)$/.test(key)) {
        const safe = safeImageUrl(v);
        if (safe === null) delete out[key];
        else out[key] = safe;
      }
    } else if (key === "bgOpacity" || key === "opacity") {
      out[key] = clampOpacity(v);
    }
  }
  return out;
}

export function sanitizeCardSpecJson(raw: unknown): {
  canvas: { w: 1080; h: 1350 };
  blocks: Array<{ kind: string; props: any }>;
  controls: {
    theme: "light" | "dark";
    brandColor: string;
    highlightColor: string;
    bgOpacity: number;
    fontFamily: string;
    textAlign: "left" | "center";
    logoPosition: "tl" | "tr" | "bl" | "br";
    fontScale?: number;
  };
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as any;
  if (!Array.isArray(r.blocks)) return null;

  const c = r.controls ?? {};
  const controls = {
    theme: c.theme === "dark" ? ("dark" as const) : ("light" as const),
    brandColor: safeColor(c.brandColor) || DEFAULT_ACCENT,
    highlightColor: safeColor(c.highlightColor) || DEFAULT_ACCENT,
    bgOpacity: clampOpacity(c.bgOpacity),
    fontFamily: FONTS.has(c.fontFamily) ? c.fontFamily : "inter",
    textAlign: ALIGNS.has(c.textAlign) ? c.textAlign : ("left" as const),
    logoPosition: LOGO_POS.has(c.logoPosition) ? c.logoPosition : ("tr" as const),
    ...(typeof c.fontScale === "number" ? { fontScale: Math.max(0.8, Math.min(1.5, c.fontScale)) } : {}),
  };

  const blocks = r.blocks
    .filter((b: any) => b && typeof b === "object" && KNOWN_BLOCKS.has(b.kind))
    .map((b: any) => ({ kind: b.kind, props: sanitizeBlockProps(b.props ?? {}) }));

  return { canvas: { w: 1080, h: 1350 }, blocks, controls };
}
```
- [ ] **Step 4: Run the test — expect PASS.**
```bash
pnpm -F @postautomation/api exec vitest run src/__tests__/sanitize-card-spec.test.ts
```
Expected: `Tests 6 passed`. (If `safeColor` returns `DEFAULT_ACCENT` for valid-but-short hex like `#abc`, the `#000`/`#fff` cases stay verbatim — assertions only check the malicious fallback path.)
- [ ] **Step 5: Commit.**
```bash
git add packages/api/src/lib/sanitize-card-spec.ts packages/api/src/__tests__/sanitize-card-spec.test.ts
git commit -m "feat(repurpose): sanitizeCardSpecJson re-validates stored CardSpec on read

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Extend `creativeTemplate` router — persist + re-sanitize CardSpec (Component 9 / D8)

**Files:**
- Modify: `packages/api/src/routers/creative-template.router.ts` (lines 24–103)
- Create test: `packages/api/src/__tests__/creative-template-cardspec.test.ts`

- [ ] **Step 1: Write the failing test (router shape + IDOR + read-sanitize wiring).** Create `packages/api/src/__tests__/creative-template-cardspec.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { assertLogoMediaOwned } from "../routers/creative-template.router";
import { sanitizeCardSpecJson } from "../lib/sanitize-card-spec";

describe("creativeTemplate cardSpec persistence + read sanitization", () => {
  it("assertLogoMediaOwned throws FORBIDDEN for a foreign media id", async () => {
    const prisma = { media: { findFirst: vi.fn(async () => null) } };
    await expect(assertLogoMediaOwned(prisma, "org1", "m-other-org")).rejects.toThrow(/not found/i);
  });

  it("assertLogoMediaOwned passes for an owned media id", async () => {
    const prisma = { media: { findFirst: vi.fn(async () => ({ id: "m1" })) } };
    await expect(assertLogoMediaOwned(prisma, "org1", "m1")).resolves.toBeUndefined();
  });

  it("assertReferenceMediaOwned throws FORBIDDEN for a foreign reference id", async () => {
    const { assertReferenceMediaOwned } = await import("../routers/creative-template.router");
    const prisma = { media: { findFirst: vi.fn(async () => null) } };
    await expect(assertReferenceMediaOwned(prisma, "org1", "ref-other")).rejects.toThrow(/not found/i);
  });

  it("a stored cardSpec with a tampered color is scrubbed on read", () => {
    const tampered = {
      canvas: { w: 1080, h: 1350 },
      controls: { theme: "light", brandColor: '#000" onload=x', highlightColor: "#fff", bgOpacity: 50, fontFamily: "inter", textAlign: "left", logoPosition: "tr" },
      blocks: [],
    };
    expect(sanitizeCardSpecJson(tampered)!.controls.brandColor).toBe("#e11d48");
  });
});
```
- [ ] **Step 2: Run the test — expect FAIL** (`assertReferenceMediaOwned` not exported yet).
```bash
pnpm -F @postautomation/api exec vitest run src/__tests__/creative-template-cardspec.test.ts
```
Expected: import of `assertReferenceMediaOwned` rejects / the dynamic import resolves `undefined` → that test fails.
- [ ] **Step 3: Add `assertReferenceMediaOwned` + a `cardSpec` zod shape + persistence.** In `packages/api/src/routers/creative-template.router.ts`, after `assertLogoMediaOwned` (line 19) add:
```ts
/** Validate an optional reference media id belongs to the org (IDOR guard). */
export async function assertReferenceMediaOwned(
  prisma: any,
  organizationId: string,
  referenceMediaId: string | undefined,
): Promise<void> {
  if (!referenceMediaId) return;
  const found = await prisma.media.findFirst({
    where: { id: referenceMediaId, organizationId },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Reference media not found in this organization." });
  }
}

// CardSpec is sanitized on READ (sanitizeCardSpecJson) and again by the renderer,
// so accept a permissive json blob on write — the store is never trusted raw.
const CARD_SPEC = z.any().optional();
```
Then add the `import { sanitizeCardSpecJson } from "../lib/sanitize-card-spec";` to the top of the file (after line 3).
- [ ] **Step 4: Re-sanitize `cardSpec` on `list`.** Replace the `list` query (lines 25–31) with:
```ts
  list: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.prisma.creativeTemplate.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      include: { logoMedia: { select: { url: true } }, referenceMedia: { select: { url: true } } },
    });
    // NEVER trust a stored cardSpec: re-sanitize every color/url before it leaves the API.
    return rows.map((r) => ({ ...r, cardSpec: r.cardSpec ? sanitizeCardSpecJson(r.cardSpec) : null }));
  }),

  getById: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.prisma.creativeTemplate.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: { logoMedia: { select: { url: true } }, referenceMedia: { select: { url: true } } },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { ...row, cardSpec: row.cardSpec ? sanitizeCardSpecJson(row.cardSpec) : null };
    }),
```
- [ ] **Step 5: Persist the new fields on `create`.** In the `create` mutation, extend the input object (lines 35–42) to add `referenceMediaId: z.string().optional()`, `cardSpec: CARD_SPEC`, `sourceUrl: z.string().url().optional()`, then in the body (lines 44–57) add the guard + fields:
```ts
    .mutation(async ({ ctx, input }) => {
      await assertLogoMediaOwned(ctx.prisma, ctx.organizationId, input.logoMediaId);
      await assertReferenceMediaOwned(ctx.prisma, ctx.organizationId, input.referenceMediaId);
      // Sanitize BEFORE storing too — store only clean JSON (defense in depth;
      // the read path re-sanitizes regardless).
      const cleanSpec = input.cardSpec ? sanitizeCardSpecJson(input.cardSpec) : null;
      return ctx.prisma.creativeTemplate.create({
        data: {
          organizationId: ctx.organizationId,
          createdById: (ctx.session.user as any).id,
          name: input.name,
          style: input.style,
          logoMediaId: input.logoMediaId,
          logoPosition: input.logoPosition,
          brandColor: input.brandColor,
          channelId: input.channelId,
          referenceMediaId: input.referenceMediaId,
          cardSpec: cleanSpec ?? undefined,
          sourceUrl: input.sourceUrl,
        },
      });
    }),
```
- [ ] **Step 6: Persist `cardSpec` on `update`.** Add `cardSpec: CARD_SPEC` to the `update` input (lines 62–69) and in the data block (lines 82–88) add: `...(input.cardSpec !== undefined && { cardSpec: sanitizeCardSpecJson(input.cardSpec) ?? undefined }),`.
- [ ] **Step 7: Run the test — expect PASS.**
```bash
pnpm -F @postautomation/api exec vitest run src/__tests__/creative-template-cardspec.test.ts
```
Expected: `Tests 4 passed`.
- [ ] **Step 8: Commit.**
```bash
git add packages/api/src/routers/creative-template.router.ts packages/api/src/__tests__/creative-template-cardspec.test.ts
git commit -m "feat(repurpose): creativeTemplate persists+resanitizes cardSpec, reference IDOR guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Repurpose router — per-slot `imageAssignments` + `aiImages` toggle, all formats (Component 4 / D10)

**Files:**
- Modify: `packages/api/src/routers/repurpose.router.ts` (input schema ~705–719; static branch ~1185–1226; carousel slide sourcing ~1778–1830)
- Create test: `packages/api/src/__tests__/repurpose-image-assignments.test.ts`

> Replaces the static-only `userMediaIds` with a per-slot `imageAssignments` map usable by static AND carousel. `aiImages` is the Real⇄AI toggle (D2). Both flow through `resolveImageSlot` (Task 2).

- [ ] **Step 1: Write the failing test for a new pure helper `resolveSlotAssignments`.** Create `packages/api/src/__tests__/repurpose-image-assignments.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveSlotAssignments, type SlotAssignment } from "../routers/repurpose.router";

describe("resolveSlotAssignments — org-scoped media id → url map", () => {
  const ownedRows = [
    { id: "m1", url: "https://cdn/u1.jpg" },
    { id: "m2", url: "https://cdn/u2.jpg" },
  ];

  it("maps assigned ids to a userImages lookup keyed by media id", () => {
    const asg: SlotAssignment[] = [
      { slot: "background", mediaId: "m1" },
      { slot: "slide:0", mediaId: "m2" },
    ];
    const map = resolveSlotAssignments(asg, ownedRows);
    expect(map).toEqual({ m1: { url: "https://cdn/u1.jpg" }, m2: { url: "https://cdn/u2.jpg" } });
  });

  it("ignores an assignment whose mediaId is not in the owned rows", () => {
    const asg: SlotAssignment[] = [{ slot: "background", mediaId: "ghost" }];
    expect(resolveSlotAssignments(asg, ownedRows)).toEqual({});
  });

  it("returns an empty map for no assignments", () => {
    expect(resolveSlotAssignments([], ownedRows)).toEqual({});
  });
});
```
- [ ] **Step 2: Run the test — expect FAIL** (`resolveSlotAssignments` not exported).
```bash
pnpm -F @postautomation/api exec vitest run src/__tests__/repurpose-image-assignments.test.ts
```
Expected: import of `resolveSlotAssignments` fails.
- [ ] **Step 3: Add the `SlotAssignment` type + `resolveSlotAssignments` helper.** In `packages/api/src/routers/repurpose.router.ts`, after `pickArticleBgImage` (line 84) add:
```ts
/**
 * A user image assigned to a specific image slot (D10). `slot` is a stable key:
 *   "background" | "inset:N" | "subject" | "grid:N" | "slide:N"
 * `mediaId` is an org-owned Media id. Multiple assignments allowed; each is
 * resolved independently by `resolveImageSlot`.
 */
export type SlotAssignment = { slot: string; mediaId: string };

/**
 * Build the `userImages` lookup (media id → { url }) consumed by `resolveImageSlot`,
 * keeping ONLY assignments whose mediaId resolved to an org-owned Media row.
 * `ownedRows` MUST already be org-scoped by the caller (assertMediaOwned). Pure +
 * exported for unit testing.
 */
export function resolveSlotAssignments(
  assignments: SlotAssignment[],
  ownedRows: Array<{ id: string; url: string }>,
): Record<string, { url: string }> {
  const byId = new Map(ownedRows.map((r) => [r.id, r.url]));
  const out: Record<string, { url: string }> = {};
  for (const a of assignments) {
    const url = byId.get(a.mediaId);
    if (url) out[a.mediaId] = { url };
  }
  return out;
}
```
- [ ] **Step 4: Add the new input fields.** In the `repurposeFromUrl` input schema, after `userMediaIds` (line 710) add:
```ts
        // D2 (Real⇄AI toggle): when false, AI image generation is OFF and slots
        // resolve real-first (user → article → branded). Default true preserves
        // prior always-AI behaviour.
        aiImages: z.boolean().default(true),
        // D10: per-slot user image assignments (all formats). Each {slot, mediaId}
        // assigns an org-owned Media id to a named slot ("background", "inset:0",
        // "slide:2", …). Org-ownership enforced before use. Supersedes the
        // static-only `userMediaIds` (kept for back-compat; mapped to background).
        imageAssignments: z
          .array(z.object({ slot: z.string().min(1).max(40), mediaId: z.string().min(1) }))
          .max(20)
          .optional(),
```
- [ ] **Step 5: Org-scope ALL assigned media once (IDOR), build `userImages` + AI context.** Inside the mutation, immediately after the `aestheticStyleDescriptor` block (after line 972, before the `buildHeadlineCreative` comment block at 974), add:
```ts
      // D10: validate every per-slot assigned media id is org-owned (IDOR), then
      // build the userImages lookup for resolveImageSlot. Back-compat: a STATIC
      // `userMediaIds[0]` with no explicit assignment maps to the "background" slot.
      const slotAssignments: SlotAssignment[] = [...(input.imageAssignments ?? [])];
      if (input.userMediaIds?.length && !slotAssignments.some((a) => a.slot === "background")) {
        slotAssignments.push({ slot: "background", mediaId: input.userMediaIds[0]! });
      }
      let userImages: Record<string, { url: string }> = {};
      if (slotAssignments.length) {
        const ids = [...new Set(slotAssignments.map((a) => a.mediaId))];
        const owned = await ctx.prisma.media.findMany({
          where: { id: { in: ids }, organizationId },
          select: { id: true, url: true },
        });
        if (owned.length !== ids.length) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "One or more attached images were not found in this workspace",
          });
        }
        userImages = resolveSlotAssignments(slotAssignments, owned);
      }
      const brandGradient = `linear-gradient(135deg, ${resolvedBrandColor || "#e11d48"}, #11131a)`;
      // Helper used by the resolver to produce an AI image for a slot. Returns a
      // data: URL. Reuses generateImageSafe + the same NO_REAL_PERSON guard. The
      // resolver swallows failures and falls through to article/branded.
      async function generateAiSlotImage(slotPrompt?: string): Promise<string> {
        const bg = await generateImageSafe({
          prompt: `${slotPrompt || "Clean editorial background photo"}\n\nIMPORTANT: clean BACKGROUND photo only — NO text, words, letters, numbers, logos, or watermarks.${NO_REAL_PERSON_CLAUSE}`,
          aspectRatio: "3:4",
          ...(brandReferenceImages.length ? { referenceImages: brandReferenceImages } : {}),
        });
        if (bg.source === "dalle") renderedEngines.add("openai");
        else renderedEngines.add("gemini");
        return `data:${bg.mimeType};base64,${bg.imageBase64}`;
      }
      // Slot context: shared across the static + carousel branches below.
      const slotCtx = (extra?: { aiPromptArticleImages?: string[] }) => ({
        aiToggle: input.aiImages,
        userImages,
        articleImages: extra?.aiPromptArticleImages ?? (extracted.images ?? []).filter((u) => typeof u === "string" && u.startsWith("https://") && isPublicImageUrl(u)),
        brandGradient,
        generateAi: generateAiSlotImage,
      });
```
(`renderedEngines` is declared at line 1183 — this helper is defined above it, so move the `const renderedEngines = new Set<...>()` declaration up to just before `generateAiSlotImage`, or reference it via closure; simplest: hoist the `renderedEngines` declaration to right after `userId`/`organizationId` at line ~762. Do that hoist as part of this step.)
- [ ] **Step 6: Rewrite the static image branch to use the resolver.** Replace the static `userMediaIds` branch (lines 1185–1226) so BOTH the user-image and AI paths flow through `resolveImageSlot` for the `background` slot:
```ts
      if (input.format === "static") {
        // Resolve the single background slot via the real-first ladder (D10/D2):
        // user-assigned → AI (if on) → article photo → branded gradient.
        const bgSlotImageRaw = await resolveImageSlot(
          { slot: "background" } as never,
          slotCtx(),
        ).catch(() => ({ url: brandGradient, source: "branded" as const }));
        const bgResolved = bgSlotImageRaw as { url: string; source: "user" | "ai" | "article" | "branded" };

        // If the slot resolved to a USER image, that image IS the post media —
        // skip the branded-creative render (parity with old userMediaIds behaviour).
        if (bgResolved.source === "user") {
          const m = await ctx.prisma.media.findFirst({
            where: { url: bgResolved.url, organizationId },
            select: { id: true, url: true },
          });
          if (m) {
            mediaUrls = [m.url];
            carouselMediaIds.push(m.id);
            mediaType = /\.png(\?|$)/i.test(m.url) ? "image/png" : "image/jpeg";
            for (const platform of input.targetPlatforms) perPlatformMedia[platform] = { url: m.url, mediaId: m.id };
            renderedBgSource = "stock";
            progress("Using your uploaded image", "done", "Your image");
          }
        }
        if (mediaUrls.length === 0) {
          // No user image → render the branded creative; the resolved bg (AI /
          // article / branded) becomes the creative background. Keep the existing
          // headline derivation + buildHeadlineCreative + uploadAndCreateMedia
          // flow below, passing `bgResolved.url` as the bgImageUrl.
          // (existing code from the old `else if (input.format === "static")` block
          //  follows here unchanged EXCEPT: pass `bgImageUrl: bgResolved.url` into
          //  buildHeadlineCreative instead of `articleBg`, and set
          //  `renderedBgSource = bgResolved.source === "ai" ? "ai" : "stock"`.)
```
Specifically: locate the existing `const articleBg = pickArticleBgImage(...)` (line 1345) inside the old static render block and the `buildHeadlineCreative(..., articleBg ? { bgImageUrl: articleBg } : undefined)` call (lines 1350–1356); change them to use `bgResolved.url` (always defined). Close the new `if (mediaUrls.length === 0) { ... }` block after the static render's media upload completes.
- [ ] **Step 7: Wire per-slide assignments into the carousel branch.** In the carousel branch, at the per-slide loop (around line 1790–1826), before the `buildHeadlineCreative` call, resolve each slide's photo via `resolveImageSlot` keyed by `slide:N`:
```ts
                // Per-slide photo (D5/D10): a user image assigned to slide N wins;
                // else AI-on → per-slide AI; else reuse the cover hero / branded.
                const slideSlot = await resolveImageSlot(
                  { slot: `slide:${slideIdx}` } as never,
                  {
                    ...slotCtx(),
                    // Cover keeps the hero; body slides reuse hero when AI off (D5).
                    articleImages: isCover && coverArticleBg ? [coverArticleBg] : (extracted.images ?? []).filter((u) => typeof u === "string" && u.startsWith("https://") && isPublicImageUrl(u)),
                  },
                ).catch(() => ({ url: brandGradient, source: "branded" as const }));
                const slidePhoto = slideSlot as { url: string; source: "user" | "ai" | "article" | "branded" };
```
Then change the `buildHeadlineCreative` carousel call to pass `bgImageUrl: slidePhoto.url` for every slide (replacing the `isCover && coverArticleBg ? { bgImageUrl: coverArticleBg }` conditional at line 1826), and add `if (slidePhoto.source === "ai") renderedEngines.add(...)` only where `buildHeadlineCreative` already reports its engine (keep the existing engine accounting; the resolver's AI path already records into `renderedEngines`).
- [ ] **Step 8: Build the package + run the test — expect PASS.**
```bash
pnpm -F @postautomation/ai build && pnpm -F @postautomation/api exec vitest run src/__tests__/repurpose-image-assignments.test.ts
```
Expected: `Tests 3 passed`. (The `@postautomation/ai build` step is required so the new `resolveImageSlot` export resolves from the api package.)
- [ ] **Step 9: Type-check the api package.**
```bash
pnpm -F @postautomation/api exec tsc --noEmit
```
Expected: no errors. If `resolveImageSlot`'s first arg type complains, the `as never` casts above bypass the strict `ImageSlot` shape since slot is keyed by name not the interface's fields — acceptable for the call site (the resolver only reads `userImageId`/`articleImageUrl`/`aiPrompt`, all undefined here, which is the fall-through case).
- [ ] **Step 10: Commit.**
```bash
git add packages/api/src/routers/repurpose.router.ts packages/api/src/__tests__/repurpose-image-assignments.test.ts
git commit -m "feat(repurpose): per-slot imageAssignments + aiImages toggle for all formats

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Repurpose router — classify reference + auto-persist saved style (Components 3 + 9)

**Files:**
- Modify: `packages/api/src/routers/repurpose.router.ts` (aesthetic-ref block ~929–972; input schema ~705)
- Create test: `packages/api/src/__tests__/repurpose-classify-persist.test.ts`

- [ ] **Step 1: Write the failing test for a pure persistence-decision helper.** Create `packages/api/src/__tests__/repurpose-classify-persist.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildSavedStyleName, shouldPersistReference } from "../routers/repurpose.router";

describe("saved-style persistence helpers", () => {
  it("buildSavedStyleName derives a readable name from a hint preset + date", () => {
    const name = buildSavedStyleName("news_inset", new Date("2026-06-13T00:00:00Z"));
    expect(name).toMatch(/News Inset/);
    expect(name).toMatch(/2026-06-13/);
  });

  it("buildSavedStyleName falls back to 'Saved style' for an unknown preset", () => {
    expect(buildSavedStyleName(undefined, new Date("2026-06-13T00:00:00Z"))).toMatch(/Saved style/);
  });

  it("shouldPersistReference true only with a stored media id AND a confident hint", () => {
    expect(shouldPersistReference("media-1", { confidence: 0.8 } as any)).toBe(true);
    expect(shouldPersistReference("media-1", { confidence: 0.2 } as any)).toBe(false);
    expect(shouldPersistReference(undefined, { confidence: 0.9 } as any)).toBe(false);
    expect(shouldPersistReference("media-1", null)).toBe(false);
  });
});
```
- [ ] **Step 2: Run the test — expect FAIL.**
```bash
pnpm -F @postautomation/api exec vitest run src/__tests__/repurpose-classify-persist.test.ts
```
Expected: imports fail.
- [ ] **Step 3: Add the two pure helpers.** In `repurpose.router.ts`, after `resolveSlotAssignments` (added in Task 6) add:
```ts
const PRESET_TITLES: Record<string, string> = {
  news_caption: "News Caption", news_inset: "News Inset",
  infographic_stats: "Infographic Stats", marketing_minimal: "Marketing Minimal",
  tweet_card: "Tweet Card", photo_grid: "Photo Grid",
  title_cover: "Title Cover", listicle_body: "Listicle Body",
};

/** Auto-name a saved style from its detected preset + date. Pure + exported. */
export function buildSavedStyleName(preset: string | undefined, now: Date): string {
  const title = (preset && PRESET_TITLES[preset]) || "Saved style";
  return `${title} — ${now.toISOString().slice(0, 10)}`;
}

/**
 * Persist a reference as a CreativeTemplate ONLY when we both stored the source
 * image (have a media id) AND classified it with reasonable confidence (≥0.5).
 * A low-confidence/failed classification is NOT auto-saved (avoids junk in the
 * gallery). Pure + exported for unit testing.
 */
export function shouldPersistReference(
  referenceMediaId: string | undefined,
  hint: { confidence: number } | null,
): boolean {
  return Boolean(referenceMediaId) && Boolean(hint) && hint!.confidence >= 0.5;
}
```
- [ ] **Step 4: Classify + persist in the aesthetic-ref block.** In the `if (input.aestheticRefUrl) { ... }` block, after `aestheticStyleDescriptor` is set (after line 953) and inside the `if (aRef) {` branch, add:
```ts
          // Component 3: structured layout detection (in addition to the prose
          // descriptor above). Used by the UI to auto-select a preset; failure
          // never blocks generation (classifyCard returns null).
          let cardHint: Awaited<ReturnType<typeof classifyCard>> = null;
          try {
            cardHint = await classifyCard(aRef.base64, aRef.mimeType);
          } catch {
            cardHint = null;
          }
          // Component 9 / D8: persist the reference image + resolved hint as a
          // reusable CreativeTemplate (auto-named). Store the source image as an
          // org Media row first, then the template. Best-effort — a failure here
          // must not break generation.
          try {
            if (cardHint) {
              const { mediaId: refMediaId } = await uploadAndCreateMedia(aRef.base64, aRef.mimeType, "styleref");
              if (shouldPersistReference(refMediaId, cardHint)) {
                await ctx.prisma.creativeTemplate.create({
                  data: {
                    organizationId,
                    createdById: userId,
                    name: buildSavedStyleName(cardHint.preset, new Date()),
                    style: input.creativeStyle,
                    logoPosition: input.logoPosition,
                    brandColor: cardHint.accentColor,
                    referenceMediaId: refMediaId,
                    sourceUrl: isPublicPageUrl(input.aestheticRefUrl) ? input.aestheticRefUrl : undefined,
                    cardSpec: {
                      canvas: { w: 1080, h: 1350 },
                      blocks: [],
                      controls: {
                        theme: cardHint.theme,
                        brandColor: cardHint.accentColor,
                        highlightColor: cardHint.accentColor,
                        bgOpacity: 60,
                        fontFamily: "inter",
                        textAlign: "left",
                        logoPosition: input.logoPosition === "top-left" ? "tl" : "tr",
                      },
                      detectedPreset: cardHint.preset,
                      detectedBlocks: cardHint.blocks,
                    },
                  },
                });
                progress("Analyzing style reference", "done", `Detected: ${cardHint.preset} — saved to your styles`);
              }
            }
          } catch (e) {
            console.warn(`[Repurpose] saved-style persistence failed (non-fatal):`, (e as Error).message);
          }
```
Add `classifyCard` to the destructured `@postautomation/ai` import list (line 757, alongside `describeImageStyle`).
- [ ] **Step 5: Run the test — expect PASS.**
```bash
pnpm -F @postautomation/api exec vitest run src/__tests__/repurpose-classify-persist.test.ts
```
Expected: `Tests 4 passed`.
- [ ] **Step 6: Type-check.**
```bash
pnpm -F @postautomation/api exec tsc --noEmit
```
Expected: no errors.
- [ ] **Step 7: Commit.**
```bash
git add packages/api/src/routers/repurpose.router.ts packages/api/src/__tests__/repurpose-classify-persist.test.ts
git commit -m "feat(repurpose): classify reference + auto-persist confident saved styles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Repurpose router — render through the engine via `renderCard` (Component 5 + D5)

**Files:**
- Modify: `packages/ai/src/tools/news-image-generator.ts` (`generateStyledCreativeImage` ~line 159)
- Create test: `packages/ai/src/__tests__/render-card-carousel.test.ts`

> Plan 2 built `renderCard(spec: CardSpec): string` + `legacyStyleToCardSpec(style, controls)`. This task routes `generateStyledCreativeImage` through `renderCard` (via the shim) so static + every carousel slide render through ONE code path with consistent body alignment, fixing the carousel inconsistency bug (Component 5). Cover≠body / body==body comes from the shim's `slideRole` mapping.

- [ ] **Step 1: Write the failing test (carousel consistency via the shim).** Create `packages/ai/src/__tests__/render-card-carousel.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderCard, legacyStyleToCardSpec } from "../tools/creative-templates";

const controls = {
  theme: "light" as const, brandColor: "#1e90ff", highlightColor: "#1e90ff",
  bgOpacity: 60, fontFamily: "inter" as const, textAlign: "left" as const, logoPosition: "tr" as const,
};

describe("carousel consistency through renderCard + legacy shim", () => {
  it("body slides share identical text-align (left) regardless of style", () => {
    const bodyA = renderCard(legacyStyleToCardSpec("premium_editorial", controls));
    const bodyB = renderCard(legacyStyleToCardSpec("hook_bars", controls));
    // Both must apply the controls.textAlign — neither inherits a stray center.
    expect(bodyA).toContain("text-align:left");
    expect(bodyB).toContain("text-align:left");
  });

  it("renders at the 1080x1350 canvas", () => {
    const html = renderCard(legacyStyleToCardSpec("tweet_card", controls));
    expect(html).toMatch(/1080/);
    expect(html).toMatch(/1350/);
  });

  it("a center-aligned control produces text-align:center", () => {
    const html = renderCard(legacyStyleToCardSpec("title_cover" as never, { ...controls, textAlign: "center" }));
    expect(html).toContain("text-align:center");
  });
});
```
- [ ] **Step 2: Run the test — expect FAIL or PASS-by-Plan-2.**
```bash
pnpm -F @postautomation/ai exec vitest run src/__tests__/render-card-carousel.test.ts
```
Expected: FAIL if `generateStyledCreativeImage` is not yet routed through `renderCard` OR if Plan 2's `legacyStyleToCardSpec` does not emit explicit `text-align`. (If Plan 2 already emits it, the test documents the contract — proceed to Step 3 to route the generator.)
- [ ] **Step 3: Route `generateStyledCreativeImage` through `renderCard`.** In `packages/ai/src/tools/news-image-generator.ts`, in `generateStyledCreativeImage` (line 159), replace the `buildStaticCreative(opts)` call with:
```ts
  // Render via the composable engine (Plan 2). Old StaticCreativeOptions callers
  // (NewsGrid/Autopilot/repurpose) are mapped to a CardSpec by the legacy shim so
  // every static image + carousel slide flows through ONE renderCard path —
  // fixing the carousel body-alignment inconsistency (Component 5).
  const { renderCard, legacyStyleToCardSpec } = await import("./creative-templates");
  const controls = {
    theme: (options.theme ?? "light") as "light" | "dark",
    brandColor: options.brandColor || "#e11d48",
    highlightColor: options.brandColor || "#e11d48",
    bgOpacity: 60,
    fontFamily: "inter" as const,
    textAlign: "left" as const,
    logoPosition: options.logoPosition === "top-left" ? ("tl" as const) : ("tr" as const),
  };
  const spec = legacyStyleToCardSpec(options.style as never, controls);
  // Plan 2's shim maps slideRole/body/hookLine/bgImageUrl/logo from `options`
  // into the CardSpec blocks; pass `options` through so the shim can read them.
  const html = renderCard({ ...spec, _legacy: options } as never);
```
(The exact `legacyStyleToCardSpec` signature is owned by Plan 2 per the type contract A.22; if its signature takes the full `StaticCreativeOptions`, pass `options` directly: `legacyStyleToCardSpec(options.style, controls, options)`. Use whichever Plan 2 shipped — confirm by reading `creative-templates.ts` exports before editing.)
- [ ] **Step 4: Run the test — expect PASS.**
```bash
pnpm -F @postautomation/ai exec vitest run src/__tests__/render-card-carousel.test.ts
```
Expected: `Tests 3 passed`.
- [ ] **Step 5: Run the existing creative-templates security suite — expect still GREEN.**
```bash
pnpm -F @postautomation/ai exec vitest run src/__tests__/creative-templates.test.ts
```
Expected: all existing XSS/CSS-injection tests pass (no regression).
- [ ] **Step 6: Commit.**
```bash
git add packages/ai/src/tools/news-image-generator.ts packages/ai/src/__tests__/render-card-carousel.test.ts
git commit -m "feat(repurpose): route generateStyledCreativeImage through renderCard engine

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: RepurposeTab UI — Real⇄AI toggle + per-slot image picker (Component 8 / D2 / D10)

**Files:**
- Modify: `apps/web/components/content-agent/RepurposeTab.tsx` (state ~141–168; controls ~720–745; mutate payloads ~530–558 and ~464–470)

- [ ] **Step 1: Add the new UI state.** In `RepurposeTab.tsx`, after the `userMedia` state (line 166) add:
```tsx
  // D2: Real⇄AI image toggle. Default ON preserves prior always-AI behaviour.
  const [aiImages, setAiImages] = useState<boolean>(true);
  // D10: per-slot user image assignments (all formats). slot key → {mediaId,url}.
  // slot keys: "background", "slide:0".."slide:N". Picker writes here; payload maps it.
  const [imageAssignments, setImageAssignments] = useState<Record<string, { mediaId: string; url: string }>>({});
```
- [ ] **Step 2: Add the Real⇄AI toggle control.** In the options panel (near the theme/style controls, around line 780), add a labeled `Switch`:
```tsx
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <div>
                  <Label className="text-sm font-medium">AI image generation</Label>
                  <p className="text-xs text-muted-foreground">
                    {aiImages ? "On — the AI invents a photo when no real one is assigned" : "Off — uses your image, the article photo, or a branded background"}
                  </p>
                </div>
                <Switch checked={aiImages} onCheckedChange={setAiImages} />
              </div>
```
- [ ] **Step 3: Add a per-slot image picker (background + per carousel slide).** Replace the existing static-only upload block (around lines 720–745) with a slot-aware picker that works for both formats. For static the slot is `"background"`; for carousel render one picker per slide `slide:0..N`. Use the existing `/api/upload` POST and the `MediaPickerDialog` (`onSelect(url, fileName, mediaId?)`):
```tsx
              {(() => {
                const slotKeys = format === "carousel"
                  ? Array.from({ length: slideCount }, (_, i) => `slide:${i}`)
                  : ["background"];
                return (
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Your images (optional)</Label>
                    <p className="text-xs text-muted-foreground">Assign your own photo to a slot — it overrides AI/article for that slot. Source is labeled honestly below.</p>
                    {slotKeys.map((slot) => {
                      const cur = imageAssignments[slot];
                      return (
                        <div key={slot} className="flex items-center gap-2">
                          <span className="w-24 shrink-0 text-xs text-muted-foreground">{slot === "background" ? "Background" : `Slide ${Number(slot.split(":")[1]) + 1}`}</span>
                          {cur ? (
                            <>
                              <img src={cur.url} alt={slot} className="h-9 w-9 rounded object-cover border" />
                              <Button type="button" variant="ghost" size="sm" onClick={() => setImageAssignments((p) => { const n = { ...p }; delete n[slot]; return n; })}>Clear</Button>
                            </>
                          ) : (
                            <>
                              <input type="file" accept="image/*" className="hidden" id={`slot-${slot}`} onChange={async (e) => {
                                const file = e.target.files?.[0]; if (!file) return;
                                const fd = new FormData(); fd.append("file", file);
                                const res = await fetch("/api/upload", { method: "POST", body: fd });
                                if (!res.ok) { toast({ title: "Upload failed", variant: "destructive" }); return; }
                                const d = await res.json();
                                setImageAssignments((p) => ({ ...p, [slot]: { mediaId: d.id, url: d.url } }));
                              }} />
                              <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById(`slot-${slot}`)?.click()}>Upload</Button>
                              <MediaPickerDialog
                                trigger={<Button type="button" variant="outline" size="sm">Library</Button>}
                                onSelect={(u, _n, mediaId) => { if (mediaId) setImageAssignments((p) => ({ ...p, [slot]: { mediaId, url: u } })); }}
                              />
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
```
(Import `MediaPickerDialog` at the top: `import { MediaPickerDialog } from "~/components/media-picker-dialog";` — confirm the component accepts a `trigger` prop; if it uses an `open`/`onOpenChange` API instead, wrap it in local `useState` open state per slot. Read `media-picker-dialog.tsx` before wiring.)
- [ ] **Step 4: Send the new fields in BOTH mutate payloads.** In the `repurposeFromUrl.mutate({...})` call (around line 530–558) add:
```tsx
        aiImages,
        imageAssignments: Object.entries(imageAssignments).map(([slot, v]) => ({ slot, mediaId: v.mediaId })),
```
Remove the legacy `userMediaIds: useOwnImage ? userMedia.map(...) : undefined` line (line 558) — superseded by `imageAssignments`. Also add the same two fields to the regenerate/second mutate payload near line 464–470 if it carries image params.
- [ ] **Step 5: Type-check the web app.**
```bash
pnpm -F @postautomation/web exec tsc --noEmit
```
Expected: no errors. (If `MediaPickerDialog` prop names differ, fix per its actual interface.)
- [ ] **Step 6: Commit.**
```bash
git add apps/web/components/content-agent/RepurposeTab.tsx
git commit -m "feat(repurpose): Real/AI toggle + per-slot image picker (all formats)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: RepurposeTab UI — per-pill Text panel + Saved-styles gallery + honest source labels (Component 8 / Component 2 / D3 / D8)

**Files:**
- Modify: `apps/web/components/content-agent/RepurposeTab.tsx` (controls ~780–970; results render ~1474–1590; state ~141–162)

- [ ] **Step 1: Add per-pill text-style state + the Text panel.** After the `accentColor` state (line 144) add:
```tsx
  // Component 2 / D3: per-pill text styling — each provably changes output.
  const [pillBgOpacity, setPillBgOpacity] = useState<number>(60); // %
  const [pillTextAlign, setPillTextAlign] = useState<"left" | "center">("left");
  const [pillFont, setPillFont] = useState<"inter" | "serif_display" | "condensed">("inter");
```
Render a "Text" panel (near the style controls) with: a highlight/accent color input bound to `accentColor`, a background-opacity range slider bound to `pillBgOpacity`, a left/center toggle bound to `pillTextAlign`, and a font select bound to `pillFont`:
```tsx
              <div className="space-y-3 rounded-lg border border-border p-3">
                <Label className="text-sm font-medium">Text style</Label>
                <div className="flex items-center gap-2">
                  <span className="w-28 text-xs text-muted-foreground">Highlight color</span>
                  <input type="color" value={accentColor || "#e11d48"} onChange={(e) => setAccentColor(e.target.value)} className="h-8 w-12 rounded border" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-28 text-xs text-muted-foreground">Caption opacity</span>
                  <input type="range" min={0} max={100} value={pillBgOpacity} onChange={(e) => setPillBgOpacity(Number(e.target.value))} className="flex-1" />
                  <span className="w-8 text-right text-xs">{pillBgOpacity}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-28 text-xs text-muted-foreground">Align</span>
                  <Button type="button" size="sm" variant={pillTextAlign === "left" ? "default" : "outline"} onClick={() => setPillTextAlign("left")}>Left</Button>
                  <Button type="button" size="sm" variant={pillTextAlign === "center" ? "default" : "outline"} onClick={() => setPillTextAlign("center")}>Center</Button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-28 text-xs text-muted-foreground">Font</span>
                  <Select value={pillFont} onValueChange={(v) => setPillFont(v as typeof pillFont)}>
                    <SelectTrigger className="h-8 flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inter">Inter</SelectItem>
                      <SelectItem value="serif_display">Serif Display</SelectItem>
                      <SelectItem value="condensed">Condensed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
```
- [ ] **Step 2: Send the text-style fields to the router.** These map to `StyleControls`. Since the router's input schema does not yet carry per-pill controls, add them to the `repurposeFromUrl` input (Task 6/this task) as a single object and thread to the engine. Add to the input schema in `repurpose.router.ts` after `aiImages`:
```ts
        styleControls: z
          .object({
            bgOpacity: z.number().int().min(0).max(100).default(60),
            textAlign: z.enum(["left", "center"]).default("left"),
            fontFamily: z.enum(["inter", "serif_display", "condensed"]).default("inter"),
          })
          .optional(),
```
And in the mutate payload (Task 9 Step 4 location) add:
```tsx
        styleControls: { bgOpacity: pillBgOpacity, textAlign: pillTextAlign, fontFamily: pillFont },
```
Then pass `input.styleControls` into the `generateStyledCreativeImage` call options (so Plan 2's shim threads them into `StyleControls`). In `buildHeadlineCreative` / `renderStaticCreative` add a `styleControls` pass-through to `generateStyledCreativeImage`'s options.
- [ ] **Step 3: Add the Saved-styles gallery.** Near the template dropdown (line 792), replace/augment it with a thumbnail gallery driven by `trpc.creativeTemplate.list`. On pick, load the saved `cardSpec` controls into the local state with NO regeneration:
```tsx
              {creativeTemplates && creativeTemplates.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Saved styles</Label>
                  <p className="text-xs text-muted-foreground">Re-use a style you saved before — applied instantly, no AI call.</p>
                  <div className="flex flex-wrap gap-2">
                    {creativeTemplates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setSelectedTemplateId(t.id);
                          if (t.style) setCreativeStyle(t.style as typeof creativeStyle);
                          if (t.brandColor) setAccentColor(t.brandColor);
                          const cs = (t as any).cardSpec?.controls;
                          if (cs) {
                            if (typeof cs.bgOpacity === "number") setPillBgOpacity(cs.bgOpacity);
                            if (cs.textAlign) setPillTextAlign(cs.textAlign);
                            if (cs.fontFamily) setPillFont(cs.fontFamily);
                            if (cs.theme) setTheme(cs.theme);
                          }
                        }}
                        className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs ${selectedTemplateId === t.id ? "border-primary bg-primary/10" : "border-border"}`}
                      >
                        {(t as any).referenceMedia?.url && <img src={(t as any).referenceMedia.url} alt={t.name} className="h-8 w-8 rounded object-cover" />}
                        <span className="max-w-[8rem] truncate">{t.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
```
- [ ] **Step 4: Add honest per-slot source labels in the results.** The router returns `renderedBgSource` / `renderedEngines`; the existing `ImageEngineChip` (line 102) already labels AI engines. Add a small source line under each rendered image in the results panel (around line 1474) that reads the assignment + bgSource:
```tsx
              <p className="text-[11px] text-muted-foreground">
                {Object.keys(imageAssignments).length > 0
                  ? "Source: Your image"
                  : results.mediaFailed
                    ? "Source: Branded background (AI unavailable)"
                    : "Source: AI-generated or article photo"}
              </p>
```
(Keep `ImageEngineChip` rendering as-is for the precise engine name.)
- [ ] **Step 5: Remove dead controls.** Per D3 ("no dead knobs"), delete any control that no longer maps to a wired field — specifically the legacy `useOwnImage`/`userMedia` upload block superseded by Task 9's per-slot picker (lines ~720–745 already replaced), and confirm the standalone `userMedia` state (line 166) and `useOwnImage` (line 168) are removed if no longer referenced. Run a quick grep:
```bash
grep -n "userMedia\b\|useOwnImage" apps/web/components/content-agent/RepurposeTab.tsx
```
Expected after cleanup: no matches (or only the removed-line context). Remove the `userMediaIds` from the payload if still present.
- [ ] **Step 6: Type-check web + api.**
```bash
pnpm -F @postautomation/web exec tsc --noEmit && pnpm -F @postautomation/api exec tsc --noEmit
```
Expected: no errors.
- [ ] **Step 7: Commit.**
```bash
git add apps/web/components/content-agent/RepurposeTab.tsx packages/api/src/routers/repurpose.router.ts
git commit -m "feat(repurpose): per-pill Text panel, Saved-styles gallery, honest source labels

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Full-suite green + security regression sweep

**Files:**
- Test only (no source change unless a regression surfaces)

- [ ] **Step 1: Run the AI package suite.**
```bash
pnpm -F @postautomation/ai test
```
Expected: all pass, including `creative-templates.test.ts` (XSS/CSS), `image-fetch-ssrf.test.ts`, the new `image-slot-resolver.test.ts`, `classify-card.test.ts`, `render-card-carousel.test.ts`.
- [ ] **Step 2: Run the API package suite.**
```bash
pnpm -F @postautomation/api test
```
Expected: all pass, including `sanitize-card-spec.test.ts`, `creative-template-cardspec.test.ts`, `repurpose-image-assignments.test.ts`, `repurpose-classify-persist.test.ts`, plus the existing `chat-action-*`, `post-create-media-idor`, `s3-config`.
- [ ] **Step 3: Security checklist verification (grep-driven).** Confirm no raw interpolation regressions:
```bash
grep -rn "execSync\|execFileSync" packages/ai/src packages/api/src apps/worker/src | grep -v test
grep -rn "imageAssignments\|userImageId" packages/api/src/routers/repurpose.router.ts | head
```
Expected: no NEW `execSync` (only the pre-existing `execFileSync` in video paths, which this work does not touch); `imageAssignments` consumers all sit behind the `assertMediaOwned`/org-scoped `findMany` count check added in Task 6 Step 5.
- [ ] **Step 4: Root type-check (all packages).**
```bash
pnpm type-check
```
Expected: turbo runs all package builds/type-checks with no errors. If `@postautomation/db` codegen is stale (new `cardSpec` field), the failing package will report a missing field on `CreativeTemplate` — re-run `pnpm --filter @postautomation/db exec prisma generate` and retry.
- [ ] **Step 5: Final commit (if any fixes were needed).**
```bash
git add -A
git commit -m "test(repurpose): full AI+API suite green, security regression sweep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
