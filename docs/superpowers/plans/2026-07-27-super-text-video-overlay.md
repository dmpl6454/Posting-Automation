# Super Text (Video Text Strip Overlay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user optionally add an Instagram-style "super text" strip (emoji, per-word colors, draggable position, live preview) to a video in Content Studio Compose; the strip is burned into the video ONCE and the burned video publishes to every selected channel. Posting without super text stays byte-identical to today.

**Architecture:** A new tiny shared package (`@postautomation/super-text`) holds the config schema + the single-source-of-truth strip HTML builder (used by BOTH the live compose preview and the worker burn — the REP-4 lesson: one rendering source, never two). `post.create` accepts `metadata.superText` (per-mediaId config map), parks the post as DRAFT (caption-fanout pattern), and enqueues ONE burn job. A new `super-text` worker renders the strip as a transparent full-frame PNG via the existing gated Puppeteer stack (color emoji support — ffmpeg `drawtext` cannot do this), composites it with ffmpeg `overlay`, uploads a **derived Media row**, swaps the post's `PostMedia` to it, then flips DRAFT→SCHEDULED. Because the publish pipeline just sees a normal video Media row, the frozen IG/FB publish paths, media-optimize, watchdog, and streaming uploads are all untouched.

**Tech Stack:** zod, Puppeteer (via `launchCreativeBrowser` from `@postautomation/ai`, `CREATIVE_RENDER_CONCURRENCY`-gated), ffmpeg (async `execFile`, argv arrays), BullMQ, Prisma Json metadata (no schema migration), React pointer events.

---

## Design decisions (locked — do not re-litigate during execution)

1. **Burn once, publish everywhere.** Burning per-target (like the legacy IG/FB `videoOverlayText` watermark pass) would re-encode N times for N channels. Instead the burn produces a derived `Media` row and swaps `PostMedia` — the entire existing publish pipeline (optimize rendition for IG, full-res for FB, streamed X/YT/LinkedIn, watchdog) operates on the burned video with **zero publish-path changes**. YouTube receiving the burned video (not the pre-burn master) is **intended** — the user asked for the text on every channel.
2. **Rendering = HTML→PNG→ffmpeg overlay, not `drawtext`.** `drawtext` cannot render color emoji or per-word colors. The strip is rendered as a transparent PNG at the video's native resolution and composited with `overlay=0:0`. The legacy `videoOverlayText` drawtext path stays untouched (nothing sets it; do not remove it).
3. **One source of truth for the strip's look.** `buildStripInnerHtml()` in `@postautomation/super-text` produces the escaped inner markup consumed by (a) the compose preview via `dangerouslySetInnerHTML` and (b) the worker's Puppeteer page. Geometry uses `em` units off one font-size, so preview (stage px) and burn (video px) scale identically. Font stack `Arial → Liberation Sans → Noto Sans` (Liberation Sans is Arial-metric-compatible; installed in the worker image) keeps wrap points aligned between macOS preview and Alpine burn.
4. **Fail visible, never degraded-silent.** If the burn fails after retries, the post goes **FAILED** with an actionable per-target error — we never publish the video *without* the text the user deliberately placed (unlike caption-fanout's degraded valve, where the shared caption is an acceptable fallback; a missing super text changes the post's meaning).
5. **Gate coordination with caption-fanout.** Both features park the post as DRAFT. Each worker clears **its own** flag, then calls a shared `flipParkedPostIfReady()` which flips only when NO gates remain. Both sides re-check after their own write → the flip can never be stranded, and a double flip is idempotent (same target state).
6. **v1 scope limits (explicit):** configured at compose/create time only (editing super text on an existing post is out of scope); one strip per video; ≤150 chars; source videos ≤950MB (matches `OPTIMIZE_SIZE_BYTES`; enforced at create with a friendly message); per-platform preview components (`instagram-preview.tsx` etc.) do NOT draw the strip in v1 — the editor dialog is THE preview (like Instagram itself). The compose tile shows a "Super text" badge.
7. **ComposeTab effect hygiene (hard rules from CLAUDE.md):** never key any new effect on `postMedia` array identity; the editor's aspect probe keys on the video URL **string** and releases its element the moment metadata arrives (`removeAttribute("src") + load()`); no `<img>` ever receives a video URL; local video files >256MB get a placeholder stage, not a `<video>`.
8. **Job IDs:** burn job `supertext:{postId}:v1` (exactly 3 colon segments, mirroring `optimize:{id}:v1`); derived-media optimize job uses the standard `optimize:{derivedId}:v1`.
9. **No Prisma migration.** `Post.metadata` and `Media.metadata` are existing `Json?` columns. All writes are additive.
10. **Rollback:** every change is guarded by "is `metadata.superText` present" — absent config keeps every code path byte-identical (mirrors the golden-gate philosophy). UI entry point is one button on video tiles; removing it disables the feature.

**Metadata shapes (canonical):**

```jsonc
// Post.metadata.superText (written by post.create, updated by the worker)
{
  "requested": true,
  "pendingBurn": true,            // cleared by the worker (success or failure)
  "parkedSchedule": true,          // true only when the post would have been SCHEDULED
  "byMediaId": { "<mediaId>": { /* SuperTextConfig */ } },
  "results": { "<mediaId>": { "status": "done", "derivedMediaId": "..." } },  // stamped per entry
  "completedAt": "ISO", "failed": true, "error": "..."                        // terminal stamps
}

// Derived Media.metadata
{
  "superText": { "sourceMediaId": "...", "burnedAt": "ISO" },
  "optimize": { "status": "pending", "enqueuedAt": "ISO" }   // then the normal optimize pipeline takes over
}
```

---

### Task 1: `@postautomation/super-text` package (schema, constants, HTML builder)

**Files:**
- Create: `packages/super-text/package.json`
- Create: `packages/super-text/tsconfig.json`
- Create: `packages/super-text/src/index.ts`
- Create: `packages/super-text/src/schema.ts`
- Create: `packages/super-text/src/constants.ts`
- Create: `packages/super-text/src/html.ts`
- Test: `packages/super-text/src/__tests__/super-text.test.ts`

- [ ] **Step 1: Create the package scaffolding**

`packages/super-text/package.json` (modeled on `packages/logger/package.json` + a vitest test script like `packages/queue`; verify the queue package's exact vitest devDependency version and mirror it):

```json
{
  "name": "@postautomation/super-text",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.8"
  }
}
```
(Check `packages/queue/package.json` for the workspace's actual `zod`/`vitest`/`typescript` versions and match them exactly.)

`packages/super-text/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/super-text/src/__tests__/super-text.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  superTextConfigSchema,
  buildStripInnerHtml,
  buildSuperTextFrameHtml,
  safeHexColor,
  type SuperTextConfig,
} from "../index";

const base: SuperTextConfig = {
  version: 1,
  segments: [{ text: "Ranveer" }, { text: "with" }, { text: "Yalina😍✨", color: "#F87171" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

describe("superTextConfigSchema", () => {
  it("accepts a valid config (emoji included)", () => {
    expect(superTextConfigSchema.safeParse(base).success).toBe(true);
  });
  it("rejects non-hex colors (CSS injection vector)", () => {
    expect(superTextConfigSchema.safeParse({ ...base, stripColor: "url(javascript:1)" }).success).toBe(false);
    expect(
      superTextConfigSchema.safeParse({ ...base, segments: [{ text: "x", color: "red;}</style>" }] }).success
    ).toBe(false);
  });
  it("rejects out-of-range geometry and >150 total chars", () => {
    expect(superTextConfigSchema.safeParse({ ...base, yPct: 120 }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, fontSizePct: 20 }).success).toBe(false);
    const long = { ...base, segments: Array.from({ length: 30 }, () => ({ text: "aaaaaaaaaa" })) };
    expect(superTextConfigSchema.safeParse(long).success).toBe(false);
  });
});

describe("buildStripInnerHtml", () => {
  it("escapes HTML in segment text (XSS)", () => {
    const html = buildStripInnerHtml({
      ...base,
      segments: [{ text: '<script>alert(1)</script>"onmouseover="x' }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('"onmouseover="');
  });
  it("renders per-segment color spans and the strip background", () => {
    const html = buildStripInnerHtml(base);
    expect(html).toContain("background:#FFFFFF");
    expect(html).toContain("color:#F87171");
    expect(html).toContain("box-decoration-break:clone");
  });
});

describe("buildSuperTextFrameHtml", () => {
  it("sizes the frame to the video and the font to fontSizePct of width", () => {
    const html = buildSuperTextFrameHtml(base, 720, 1280);
    expect(html).toContain("width:720px");
    expect(html).toContain("height:1280px");
    expect(html).toContain(`font-size:${Math.round((4.2 / 100) * 720)}px`);
    expect(html).toContain("left:50%");
    expect(html).toContain("top:72%");
    expect(html).toContain("background:transparent");
  });
});

describe("safeHexColor", () => {
  it("falls back on anything that is not #RRGGBB", () => {
    expect(safeHexColor("#ff0000", "#111111")).toBe("#ff0000");
    expect(safeHexColor("javascript:alert(1)", "#111111")).toBe("#111111");
    expect(safeHexColor(undefined, "#111111")).toBe("#111111");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @postautomation/super-text test` (after `pnpm install` to link the new package)
Expected: FAIL — module `../index` has no exports.

- [ ] **Step 4: Implement the package**

`packages/super-text/src/schema.ts`:

```ts
import { z } from "zod";

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export const superTextSegmentSchema = z.object({
  text: z.string().min(1).max(60),
  /** Optional per-word color override (#RRGGBB only — validated, never interpolated raw). */
  color: z.string().regex(HEX6).optional(),
});

export const superTextConfigSchema = z.object({
  version: z.literal(1),
  segments: z
    .array(superTextSegmentSchema)
    .min(1)
    .max(30)
    .refine(
      (segs) => segs.reduce((n, s) => n + s.text.length, 0) <= 150,
      "Super text is limited to 150 characters"
    ),
  stripColor: z.string().regex(HEX6),
  textColor: z.string().regex(HEX6),
  /** Strip anchor (its CENTER), as a percentage of the video frame. */
  xPct: z.number().min(5).max(95),
  yPct: z.number().min(5).max(95),
  /** Font size as a percentage of the video WIDTH (device-independent). */
  fontSizePct: z.number().min(2).max(8),
});

export type SuperTextConfig = z.infer<typeof superTextConfigSchema>;

/** mediaId → config map, as sent in post.create metadata.superText */
export const superTextMapSchema = z.record(z.string(), superTextConfigSchema);
export type SuperTextMap = z.infer<typeof superTextMapSchema>;
```

`packages/super-text/src/constants.ts`:

```ts
/**
 * Geometry is expressed in `em` off ONE font-size so the live compose preview
 * (font-size = fontSizePct% of the stage width) and the worker burn
 * (fontSizePct% of the real video width) produce the SAME layout at different
 * scales. Font stack note: Liberation Sans (Alpine worker) is metric-compatible
 * with Arial (macOS/Windows preview) so wrap points match across environments.
 * Single quotes inside the stacks are REQUIRED — these strings are interpolated
 * into style="" attributes (double quotes would terminate the attribute).
 */
export const SUPER_TEXT_FONT_STACK =
  "Arial, 'Liberation Sans', 'Noto Sans', 'Helvetica Neue', Helvetica, sans-serif";
export const SUPER_TEXT_EMOJI_STACK =
  "'Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Emoji'";
export const STRIP_PAD_Y_EM = 0.34;
export const STRIP_PAD_X_EM = 0.55;
export const STRIP_RADIUS_EM = 0.28;
export const STRIP_LINE_HEIGHT = 1.5;
export const STRIP_MAX_WIDTH_PCT = 88;
export const STRIP_FONT_WEIGHT = 700;
/** Editor size presets → fontSizePct */
export const FONT_SIZE_PRESETS = { S: 3.2, M: 4.2, L: 5.4 } as const;
export const SUPER_TEXT_DEFAULTS = {
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: FONT_SIZE_PRESETS.M,
} as const;
```

`packages/super-text/src/html.ts`:

```ts
import type { SuperTextConfig } from "./schema";
import {
  SUPER_TEXT_FONT_STACK,
  SUPER_TEXT_EMOJI_STACK,
  STRIP_PAD_Y_EM,
  STRIP_PAD_X_EM,
  STRIP_RADIUS_EM,
  STRIP_LINE_HEIGHT,
  STRIP_MAX_WIDTH_PCT,
  STRIP_FONT_WEIGHT,
} from "./constants";

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Defense-in-depth: schema already validates, but the builder NEVER trusts input. */
export function safeHexColor(value: string | undefined, fallback: string): string {
  return value && HEX6.test(value) ? value : fallback;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The SINGLE source of truth for the strip's look — consumed by BOTH the
 * compose live preview (dangerouslySetInnerHTML) and the worker burn
 * (Puppeteer setContent). REP-4 lesson: never maintain two renderings of the
 * same content. All text is escaped; all colors are hex-validated.
 * `box-decoration-break: clone` gives the per-line pill wrap (IG look).
 */
export function buildStripInnerHtml(config: SuperTextConfig): string {
  const textColor = safeHexColor(config.textColor, "#111111");
  const stripColor = safeHexColor(config.stripColor, "#FFFFFF");
  const words = config.segments
    .map((seg) => {
      const color = seg.color ? safeHexColor(seg.color, textColor) : textColor;
      return `<span style="color:${color}">${escapeHtml(seg.text)}</span>`;
    })
    .join(" ");
  return (
    `<span style="background:${stripColor};color:${textColor};` +
    `font-weight:${STRIP_FONT_WEIGHT};` +
    `font-family:${SUPER_TEXT_FONT_STACK}, ${SUPER_TEXT_EMOJI_STACK};` +
    `line-height:${STRIP_LINE_HEIGHT};` +
    `padding:${STRIP_PAD_Y_EM}em ${STRIP_PAD_X_EM}em;` +
    `border-radius:${STRIP_RADIUS_EM}em;` +
    `-webkit-box-decoration-break:clone;box-decoration-break:clone;` +
    `white-space:pre-wrap;">${words}</span>`
  );
}

/**
 * Full-frame transparent page for the worker burn: rendered at the video's
 * native resolution, screenshotted with omitBackground, composited by ffmpeg
 * at overlay=0:0 — so position math lives in ONE place (this CSS), identical
 * to the preview's percentage positioning.
 */
export function buildSuperTextFrameHtml(
  config: SuperTextConfig,
  videoWidth: number,
  videoHeight: number
): string {
  const w = Math.max(16, Math.min(7680, Math.round(videoWidth)));
  const h = Math.max(16, Math.min(7680, Math.round(videoHeight)));
  const fontPx = Math.round((config.fontSizePct / 100) * w);
  const xPct = Math.min(95, Math.max(5, config.xPct));
  const yPct = Math.min(95, Math.max(5, config.yPct));
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;background:transparent;width:${w}px;height:${h}px;overflow:hidden}` +
    `.anchor{position:absolute;left:${xPct}%;top:${yPct}%;transform:translate(-50%,-50%);` +
    `max-width:${STRIP_MAX_WIDTH_PCT}%;text-align:center;font-size:${fontPx}px}` +
    `</style></head><body><div class="anchor">${buildStripInnerHtml(config)}</div></body></html>`
  );
}
```

`packages/super-text/src/index.ts`:

```ts
export {
  superTextSegmentSchema,
  superTextConfigSchema,
  superTextMapSchema,
  type SuperTextConfig,
  type SuperTextMap,
} from "./schema";
export * from "./constants";
export { buildStripInnerHtml, buildSuperTextFrameHtml, safeHexColor, escapeHtml } from "./html";
```

- [ ] **Step 5: Run `pnpm install` (links the workspace package), then the tests**

Run: `pnpm install && pnpm --filter @postautomation/super-text test`
Expected: PASS (all suites).

- [ ] **Step 6: Commit**

```bash
git add packages/super-text pnpm-lock.yaml
git commit -m "feat(super-text): shared config schema + single-source strip HTML builder"
```

---

### Task 2: Queue — `super-text` queue + job type

**Files:**
- Modify: `packages/queue/src/types.ts` (add job data interface, near `MediaOptimizeJobData`)
- Modify: `packages/queue/src/queues.ts` (QUEUE_NAMES entry + queue export, mirroring `mediaOptimizeQueue`)
- Modify: `packages/queue/src/index.ts` (re-export)

- [ ] **Step 1: Add the type** — in `packages/queue/src/types.ts`, next to the existing job-data interfaces:

```ts
export interface SuperTextBurnJobData {
  postId: string;
  organizationId: string;
}
```

- [ ] **Step 2: Add queue name + instance** — in `packages/queue/src/queues.ts`:

Add to `QUEUE_NAMES`:
```ts
  SUPER_TEXT: "super-text",
```
Add after `mediaOptimizeQueue` (line ~66):
```ts
export const superTextQueue = createQueue<SuperTextBurnJobData>(QUEUE_NAMES.SUPER_TEXT);
```
(Import `SuperTextBurnJobData` in the file's type-import list.)

- [ ] **Step 3: Re-export** — in `packages/queue/src/index.ts` line 2, append `superTextQueue` to the export list from `./queues`, and export the type from `./types` alongside its siblings.

- [ ] **Step 4: Verify** — Run: `pnpm --filter @postautomation/queue test && pnpm --filter @postautomation/queue exec tsc --noEmit`
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/queue
git commit -m "feat(queue): super-text burn queue"
```

---

### Task 3: API planner — `planSuperText` (pure) + tests

**Files:**
- Create: `packages/api/src/lib/super-text.ts`
- Test: `packages/api/src/__tests__/super-text-plan.test.ts`
- Modify: `packages/api/package.json` (add `"@postautomation/super-text": "workspace:*"` to dependencies — match the exact workspace-protocol style used for the other `@postautomation/*` deps in that file)

- [ ] **Step 1: Write the failing test**

`packages/api/src/__tests__/super-text-plan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planSuperText, superTextJobId, SUPER_TEXT_MAX_SOURCE_BYTES } from "../lib/super-text";

const cfg = {
  version: 1 as const,
  segments: [{ text: "hello" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

const video = (id: string, size = 1000) => ({ id, fileType: "video/mp4", fileSize: size });
const image = (id: string) => ({ id, fileType: "image/png", fileSize: 100 });

describe("planSuperText", () => {
  it("disabled when no config — normal posting untouched", () => {
    const plan = planSuperText({ superText: undefined, mediaRows: [video("a")], scheduledAt: "2026-08-01T00:00:00Z" });
    expect(plan).toEqual({ enabled: false, parkedSchedule: false, byMediaId: {}, oversized: [] });
  });
  it("only applies to VIDEO media actually attached to the post", () => {
    const plan = planSuperText({
      superText: { a: cfg, b: cfg, ghost: cfg },
      mediaRows: [video("a"), image("b")],
      scheduledAt: null,
    });
    expect(Object.keys(plan.byMediaId)).toEqual(["a"]);
    expect(plan.enabled).toBe(true);
    expect(plan.parkedSchedule).toBe(false); // draft — no schedule to park
  });
  it("parks the schedule only when scheduledAt is set", () => {
    const plan = planSuperText({ superText: { a: cfg }, mediaRows: [video("a")], scheduledAt: new Date() });
    expect(plan.parkedSchedule).toBe(true);
  });
  it("flags oversized sources instead of enabling them", () => {
    const plan = planSuperText({
      superText: { a: cfg },
      mediaRows: [video("a", SUPER_TEXT_MAX_SOURCE_BYTES + 1)],
      scheduledAt: null,
    });
    expect(plan.enabled).toBe(false);
    expect(plan.oversized).toEqual(["a"]);
  });
});

describe("superTextJobId", () => {
  it("is exactly 3 colon segments (BullMQ >=5.70 contract)", () => {
    expect(superTextJobId("p1")).toBe("supertext:p1:v1");
    expect(superTextJobId("p1").split(":").length).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @postautomation/api test -- super-text-plan`
Expected: FAIL — `../lib/super-text` not found.

- [ ] **Step 3: Implement**

`packages/api/src/lib/super-text.ts`:

```ts
import type { SuperTextConfig, SuperTextMap } from "@postautomation/super-text";

/**
 * Super-text source cap — matches OPTIMIZE_SIZE_BYTES (950MB): larger sources
 * would need the rendition dance mid-burn on a 4-core box. Enforced at CREATE
 * with a friendly message (and re-checked in the worker).
 */
export const SUPER_TEXT_MAX_SOURCE_BYTES = 950 * 1024 * 1024;

/**
 * Pure planner (mirrors planCaptionFanout): decides whether the post must be
 * parked as DRAFT for the burn, and which (mediaId → config) entries are
 * actually burnable (video, attached, within size cap).
 */
export function planSuperText(input: {
  superText: SuperTextMap | undefined;
  mediaRows: { id: string; fileType: string; fileSize: number }[];
  scheduledAt: string | Date | null | undefined;
}): {
  enabled: boolean;
  parkedSchedule: boolean;
  byMediaId: Record<string, SuperTextConfig>;
  oversized: string[];
} {
  const byMediaId: Record<string, SuperTextConfig> = {};
  const oversized: string[] = [];
  if (input.superText) {
    for (const row of input.mediaRows) {
      const cfg = input.superText[row.id];
      if (!cfg || !row.fileType.startsWith("video/")) continue;
      if (row.fileSize > SUPER_TEXT_MAX_SOURCE_BYTES) {
        oversized.push(row.id);
        continue;
      }
      byMediaId[row.id] = cfg;
    }
  }
  const enabled = Object.keys(byMediaId).length > 0;
  return { enabled, parkedSchedule: enabled && input.scheduledAt != null, byMediaId, oversized };
}

/** Exactly 3 colon segments — BullMQ >=5.70 rejects other colon counts. */
export function superTextJobId(postId: string): string {
  return `supertext:${postId}:v1`;
}
```

- [ ] **Step 4: Run tests** — `pnpm install && pnpm --filter @postautomation/api test -- super-text-plan`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/super-text.ts packages/api/src/__tests__/super-text-plan.test.ts packages/api/package.json pnpm-lock.yaml
git commit -m "feat(api): pure super-text burn planner"
```

---

### Task 4: `post.create` integration + `publishNow` guard

**Files:**
- Modify: `packages/api/src/routers/post.router.ts`
  - line 4 import: add `superTextQueue` to the `@postautomation/queue` import
  - line ~10: `import { planSuperText, superTextJobId } from "../lib/super-text";` and `import { superTextMapSchema } from "@postautomation/super-text";`
  - lines 130–135 (metadata schema), 215–239 (park logic), after 298–303 (enqueue), `publishNow` (~558)
- Test: `packages/api/src/__tests__/super-text-create.test.ts` (mock-prisma style — model on `packages/api/src/__tests__/post-archive.test.ts` for the caller/mocking pattern used in this repo)

- [ ] **Step 1: Extend the metadata schema** — in the `create` input (line 130–135), add `superText`:

```ts
        metadata: z.object({
          title: z.string().optional(),
          tags: z.array(z.string()).optional(),
          privacyStatus: z.enum(["public", "unlisted", "private"]).optional(),
          videoOverlayText: z.string().optional(),
          // Super text: per-mediaId strip config, burned into the video by the
          // super-text worker BEFORE publish. Optional — absent keeps every
          // path byte-identical.
          superText: superTextMapSchema.optional(),
        }).passthrough().optional(),
```

- [ ] **Step 2: Plan + park** — after the `planCaptionFanout` call (line 215–219), insert:

```ts
      // Super text: burn strip into video(s) BEFORE publish. The post parks as
      // DRAFT (like caption-fanout) while ONE burn job produces derived Media
      // rows and swaps the attachments; the worker (or flipParkedPostIfReady)
      // flips DRAFT→SCHEDULED when every gate is clear.
      let superTextPlan: ReturnType<typeof planSuperText> = {
        enabled: false, parkedSchedule: false, byMediaId: {}, oversized: [],
      };
      if (input.metadata?.superText && input.mediaIds?.length) {
        const stRows = await ctx.prisma.media.findMany({
          where: { id: { in: input.mediaIds } },
          select: { id: true, fileType: true, fileSize: true },
        });
        superTextPlan = planSuperText({
          superText: input.metadata.superText,
          mediaRows: stRows.map((r) => ({ id: r.id, fileType: r.fileType, fileSize: Number(r.fileSize) })),
          scheduledAt: input.scheduledAt ?? null,
        });
        if (superTextPlan.oversized.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Super text is supported for videos up to 950MB. Remove the super text or attach a smaller video.",
          });
        }
      }
```

- [ ] **Step 3: Status + metadata write** — replace line 221 and the `metadata:` expression at 234–239 with:

```ts
      const status = captionFanout.enabled || superTextPlan.parkedSchedule
        ? "DRAFT"
        : input.scheduledAt ? "SCHEDULED" : "DRAFT";
```

```ts
          metadata: (() => {
            // Strip the RAW client superText map — the normalized gate block below
            // is the only persisted shape. No gates + no metadata → undefined
            // (byte-identical to the pre-feature write).
            const { superText: _rawSuperText, ...rest } = (input.metadata ?? {}) as Record<string, unknown>;
            const out: Record<string, unknown> = { ...rest };
            if (captionFanout.enabled) {
              out.captionFanout = { requested: true, pendingSchedule: captionFanout.pendingSchedule };
            }
            if (superTextPlan.enabled) {
              out.superText = {
                requested: true,
                pendingBurn: true,
                parkedSchedule: superTextPlan.parkedSchedule,
                byMediaId: superTextPlan.byMediaId,
              };
            }
            return (Object.keys(out).length > 0 ? out : undefined) as any;
          })(),
```

- [ ] **Step 4: Enqueue the burn job** — after the caption-fanout enqueue block (~line 298–303), mirroring its awaited style:

```ts
      // Super text: ONE burn job per post (jobId dedupes re-submits). The worker
      // burns, swaps PostMedia to the derived Media, then flips when no gates remain.
      if (superTextPlan.enabled) {
        await superTextQueue.add(
          "burn",
          { postId: post.id, organizationId: ctx.organizationId },
          {
            jobId: superTextJobId(post.id),
            attempts: 2,
            backoff: { type: "exponential", delay: 60_000 },
            removeOnComplete: { age: 3600 },
            removeOnFail: { age: 24 * 3600 },
          }
        );
      }
```

- [ ] **Step 5: `publishNow` guard** — in the `publishNow` mutation (~line 558): after the existing org-scoped post fetch (add `metadata: true` to its select if not already selected), before the `status: "SCHEDULED"` updates at ~578:

```ts
      const postMeta = (post.metadata ?? {}) as Record<string, any>;
      if (postMeta.superText?.pendingBurn === true) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Super text is still being applied to your video. The post will be scheduled automatically when it's ready — or try again in a minute.",
        });
      }
```

- [ ] **Step 6: Write the create-path tests**

`packages/api/src/__tests__/super-text-create.test.ts` — follow the repo's existing mock-caller pattern (see `post-archive.test.ts` for how `post.router` procedures are unit-tested with a mocked prisma + queue). Lock these behaviors:

```ts
// 1. superText + video media + scheduledAt → post created DRAFT,
//    metadata.superText = { requested, pendingBurn: true, parkedSchedule: true, byMediaId },
//    superTextQueue.add called ONCE with jobId "supertext:<postId>:v1",
//    enqueueScheduledPublishJobs NOT called (post is DRAFT).
// 2. superText + video media, NO scheduledAt → DRAFT, parkedSchedule false, burn job still enqueued.
// 3. superText config for an IMAGE-only post → plan disabled: status follows the
//    normal rules, NO metadata.superText block, NO burn job.
// 4. NO superText → metadata written EXACTLY as input.metadata (undefined when absent) —
//    the byte-identical regression lock.
// 5. Oversized video (fileSize > 950MB) + superText → TRPCError BAD_REQUEST, no post row leaked
//    (assert prisma.post.create not called).
// 6. publishNow on a post whose metadata.superText.pendingBurn === true → BAD_REQUEST;
//    with pendingBurn false → proceeds (status updates fire).
```
Write each as a real test with the mocked prisma/queue harness — all six must exist and pass.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @postautomation/api test`
Expected: PASS (new suite + all existing post tests unchanged — especially the caption-fanout and archive suites).

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/routers/post.router.ts packages/api/src/__tests__/super-text-create.test.ts
git commit -m "feat(api): post.create super-text park+enqueue, publishNow burn guard"
```

---

### Task 5: Worker pure lib — composite args + duration integrity + gate flip

**Files:**
- Create: `apps/worker/src/lib/super-text-burn.ts`
- Create: `apps/worker/src/lib/publish-gates.ts`
- Test: `apps/worker/src/lib/__tests__/super-text-burn.test.ts` (place beside existing worker lib tests — check where `media-optimize`'s tests live, e.g. `apps/worker/src/lib/__tests__/` or `apps/worker/src/__tests__/`, and match)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildSuperTextCompositeArgs, durationIntegrityOk } from "../super-text-burn";
import { pendingPublishGates, wasParkedForSchedule } from "../publish-gates";

describe("buildSuperTextCompositeArgs", () => {
  it("is a pure argv array: overlay at 0:0, H.264, audio copied, faststart", () => {
    const args = buildSuperTextCompositeArgs({
      inputPath: "/tmp/in.mp4",
      overlayPngPath: "/tmp/strip.png",
      outputPath: "/tmp/out.mp4",
    });
    expect(args[0]).toBe("-y");
    expect(args).toContain("/tmp/in.mp4");
    expect(args).toContain("/tmp/strip.png");
    expect(args.join(" ")).toContain("[0:v][1:v]overlay=0:0");
    expect(args).toContain("libx264");
    expect(args).toContain("copy"); // -c:a copy
    expect(args).toContain("+faststart");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });
});

describe("durationIntegrityOk (PR #144 truncation guard)", () => {
  it("passes within 2%, fails a truncated encode, fail-open on unknown source", () => {
    expect(durationIntegrityOk(60, 59.2)).toBe(true);
    expect(durationIntegrityOk(63, 40)).toBe(false);
    expect(durationIntegrityOk(undefined, 40)).toBe(true);
    expect(durationIntegrityOk(60, undefined)).toBe(false);
  });
});

describe("publish gates", () => {
  it("reports pending gates from post metadata", () => {
    expect(pendingPublishGates({ captionFanout: { pendingSchedule: true } })).toEqual(["captionFanout"]);
    expect(pendingPublishGates({ superText: { pendingBurn: true } })).toEqual(["superText"]);
    expect(pendingPublishGates({ superText: { pendingBurn: false } })).toEqual([]);
    expect(pendingPublishGates(null)).toEqual([]);
  });
  it("knows whether any gate parked the schedule", () => {
    expect(wasParkedForSchedule({ superText: { parkedSchedule: true } })).toBe(true);
    expect(wasParkedForSchedule({ captionFanout: { requested: true } })).toBe(true);
    expect(wasParkedForSchedule({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @postautomation/worker test -- super-text-burn`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/worker/src/lib/super-text-burn.ts`:

```ts
/**
 * Pure helpers for the super-text burn (worker-side ffmpeg composite).
 * SECURITY: argv arrays only — executed via async execFile (NO shell), same
 * contract as video-overlay.ts / media-optimize.ts.
 */
export function buildSuperTextCompositeArgs(opts: {
  inputPath: string;
  overlayPngPath: string;
  outputPath: string;
}): string[] {
  return [
    "-y",
    "-i", opts.inputPath,
    "-i", opts.overlayPngPath,
    "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[vout]",
    "-map", "[vout]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-threads", "3",
    opts.outputPath,
  ];
}

/**
 * PR #144 lesson: a stalled encode can exit 0 with a TRUNCATED output. The
 * burned video must be within 2% of the source duration or the burn FAILS
 * (never publish a cut video). Fail-open only when the SOURCE duration is
 * unknown (probe gap), fail-closed when the OUTPUT duration is unreadable.
 */
export function durationIntegrityOk(
  sourceSec: number | undefined,
  outputSec: number | undefined
): boolean {
  if (!sourceSec || !Number.isFinite(sourceSec)) return true;
  if (!outputSec || !Number.isFinite(outputSec)) return false;
  return outputSec >= sourceSec * 0.98;
}
```

`apps/worker/src/lib/publish-gates.ts`:

```ts
/**
 * Publish gates: features that PARK a post as DRAFT while async work runs
 * (caption-fanout captions, super-text burn). Each worker clears ITS OWN flag
 * then calls flipParkedPostIfReady — the flip happens exactly when no gates
 * remain. Both sides re-check AFTER their own metadata write, so two gates
 * finishing simultaneously can never strand the post (a double flip is
 * idempotent: same target state).
 */
export function pendingPublishGates(meta: Record<string, any> | null | undefined): string[] {
  const gates: string[] = [];
  if (meta?.captionFanout?.pendingSchedule === true) gates.push("captionFanout");
  if (meta?.superText?.pendingBurn === true) gates.push("superText");
  return gates;
}

export function wasParkedForSchedule(meta: Record<string, any> | null | undefined): boolean {
  return meta?.captionFanout?.requested === true || meta?.superText?.parkedSchedule === true;
}

export async function flipParkedPostIfReady(
  prisma: {
    post: { findFirst: Function; update: Function };
    postTarget: { updateMany: Function };
  },
  postId: string,
  organizationId: string
): Promise<boolean> {
  const post = await prisma.post.findFirst({
    where: { id: postId, organizationId },
    select: { id: true, status: true, scheduledAt: true, metadata: true },
  });
  if (!post || post.status !== "DRAFT" || !post.scheduledAt) return false;
  const meta = (post.metadata ?? {}) as Record<string, any>;
  if (pendingPublishGates(meta).length > 0) return false;
  if (!wasParkedForSchedule(meta)) return false;
  await prisma.postTarget.updateMany({
    where: { postId, status: "DRAFT" },
    data: { status: "SCHEDULED" },
  });
  await prisma.post.update({ where: { id: postId }, data: { status: "SCHEDULED" } });
  return true;
}
```

- [ ] **Step 4: Run tests** — `pnpm --filter @postautomation/worker test -- super-text-burn`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/super-text-burn.ts apps/worker/src/lib/publish-gates.ts apps/worker/src/lib/__tests__/super-text-burn.test.ts
git commit -m "feat(worker): super-text composite args, duration guard, shared publish-gate flip"
```

---

### Task 6: `super-text.worker.ts` — burn, derive Media, swap, flip

**Files:**
- Create: `apps/worker/src/workers/super-text.worker.ts`
- Modify: `apps/worker/src/index.ts` (import + `registerWorker("super-text")` + instantiate + graceful-shutdown list — mirror the `createMediaOptimizeWorker` lines exactly)
- Modify: `apps/worker/package.json` (add `"@postautomation/super-text": "workspace:*"`)
- Test: `apps/worker/src/workers/__tests__/super-text.worker.test.ts` (mirror the location/mocking style of the caption-fanout worker tests — find them with `grep -rl "runCaptionFanout" apps/worker/src`)

- [ ] **Step 1: Implement the worker** (exported pure-ish `runSuperTextBurn(data, deps)` for testability + a thin `createSuperTextWorker()`, mirroring caption-fanout's structure):

`apps/worker/src/workers/super-text.worker.ts`:

```ts
import { Worker, type Job } from "bullmq";
import { execFile } from "child_process";
import { promisify } from "util";
import { createReadStream, promises as fsp } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  mediaOptimizeQueue,
  createRedisConnection,
  type SuperTextBurnJobData,
} from "@postautomation/queue";
import { buildSuperTextFrameHtml, superTextConfigSchema } from "@postautomation/super-text";
import { launchCreativeBrowser } from "@postautomation/ai";
import { buildSuperTextCompositeArgs, durationIntegrityOk } from "../lib/super-text-burn";
import { flipParkedPostIfReady } from "../lib/publish-gates";

const execFileAsync = promisify(execFile);

const s3 = new S3Client({
  region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});
const S3_BUCKET = process.env.S3_BUCKET || "postautomation-media";
const S3_BASE_URL = process.env.S3_PUBLIC_URL || process.env.S3_BASE_URL || `https://${S3_BUCKET}.s3.amazonaws.com`;

const PROBE_TIMEOUT_MS = 60_000;
const BURN_TIMEOUT_MS = Number(process.env.SUPER_TEXT_TIMEOUT_MS || 30 * 60 * 1000);
const MAX_SOURCE_BYTES = 950 * 1024 * 1024; // re-check of the create-time cap

export const SUPER_TEXT_FAIL_MESSAGE =
  "Super text could not be applied to your video. Edit the post to try again, or remove the super text.";

async function probe(url: string) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", url],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
  );
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const v = data.streams?.find((s) => s.codec_type === "video");
  return {
    width: v?.width,
    height: v?.height,
    durationSec: data.format?.duration ? parseFloat(data.format.duration) || undefined : undefined,
  };
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`source download failed: HTTP ${res.status}`);
  const { Readable } = await import("stream");
  const { pipeline } = await import("stream/promises");
  const { createWriteStream } = await import("fs");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
}

/** Render the strip as a transparent full-frame PNG at the video's native size. */
async function renderStripPng(cfgHtml: string, width: number, height: number, outPath: string): Promise<void> {
  const browser = await launchCreativeBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setContent(cfgHtml, { waitUntil: "load", timeout: 30_000 });
    const png = (await page.screenshot({ type: "png", omitBackground: true, encoding: "base64" })) as string;
    await fsp.writeFile(outPath, Buffer.from(png, "base64"));
  } finally {
    await browser.close().catch(() => undefined); // closing releases the render slot
  }
}

/** Merge-patch metadata.superText on the post (fresh read → additive write). */
async function stampSuperText(postId: string, patch: Record<string, unknown>) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { metadata: true } });
  const meta = ((post?.metadata as Record<string, unknown>) ?? {});
  const st = ((meta.superText as Record<string, unknown>) ?? {});
  await prisma.post.update({
    where: { id: postId },
    data: { metadata: { ...meta, superText: { ...st, ...patch } } as any },
  });
}

/**
 * FAIL-VISIBLE terminal path (design decision #4): never publish the video
 * without the text the user placed. Org-scoped + idempotent (only acts while
 * pendingBurn is still true).
 */
export async function markSuperTextFailed(
  postId: string,
  organizationId: string,
  errorDetail: string
): Promise<void> {
  const post = await prisma.post.findFirst({
    where: { id: postId, organizationId },
    select: { id: true, status: true, metadata: true },
  });
  if (!post) return;
  const meta = ((post.metadata as Record<string, unknown>) ?? {});
  const st = ((meta.superText as Record<string, any>) ?? {});
  if (st.pendingBurn !== true) return;
  await prisma.postTarget.updateMany({
    where: { postId, status: { in: ["DRAFT", "SCHEDULED"] } },
    data: { status: "FAILED", errorMessage: SUPER_TEXT_FAIL_MESSAGE },
  });
  await prisma.post.update({
    where: { id: postId },
    data: {
      status: "FAILED",
      metadata: {
        ...meta,
        superText: {
          ...st,
          pendingBurn: false,
          failed: true,
          error: String(errorDetail).slice(0, 300),
          completedAt: new Date().toISOString(),
        },
      } as any,
    },
  });
}

export async function runSuperTextBurn(data: SuperTextBurnJobData): Promise<
  { burned: number; skipped: number; flipped: boolean } | { skipped: string }
> {
  const { postId, organizationId } = data;
  const post = await prisma.post.findFirst({
    where: { id: postId, organizationId },
    include: { mediaAttachments: { include: { media: true } } },
  });
  if (!post) return { skipped: "post_not_found" };
  const meta = ((post.metadata as Record<string, any>) ?? {});
  const st = meta.superText ?? {};
  if (st.pendingBurn !== true) return { skipped: "not_pending" };

  const byMediaId: Record<string, unknown> = st.byMediaId ?? {};
  const results: Record<string, any> = { ...(st.results ?? {}) };
  let burned = 0;
  let skipped = 0;

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "supertext-"));
  try {
    for (const [mediaId, rawCfg] of Object.entries(byMediaId)) {
      if (results[mediaId]?.status === "done") { skipped++; continue; } // retry idempotency
      const parsed = superTextConfigSchema.safeParse(rawCfg);
      if (!parsed.success) throw new Error(`invalid super-text config for media ${mediaId}`);
      const attachment = post.mediaAttachments.find((a) => a.mediaId === mediaId);
      const media = attachment?.media;
      if (!media || !media.fileType.startsWith("video/")) { skipped++; continue; }
      if (Number(media.fileSize) > MAX_SOURCE_BYTES) {
        throw new Error(`source ${mediaId} exceeds the 950MB super-text cap`);
      }

      // Probe is a metadata read (range-seeks) — safe over http, unlike long encodes.
      const src = await probe(media.url);
      const width = src.width && src.width >= 16 ? src.width : 1080;
      const height = src.height && src.height >= 16 ? src.height : 1920;

      const stripPath = path.join(tmpDir, `strip-${mediaId}.png`);
      const inputPath = path.join(tmpDir, `in-${mediaId}.mp4`);
      const outputPath = path.join(tmpDir, `out-${mediaId}.mp4`);

      await renderStripPng(buildSuperTextFrameHtml(parsed.data, width, height), width, height, stripPath);
      // PR #144: stream the source to disk FIRST — never let a long ffmpeg
      // encode read http through nginx (silent truncation on send-timeout).
      await downloadToFile(media.url, inputPath);
      await execFileAsync(
        "ffmpeg",
        buildSuperTextCompositeArgs({ inputPath, overlayPngPath: stripPath, outputPath }),
        { timeout: BURN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
      );
      const out = await probe(outputPath);
      if (!durationIntegrityOk(src.durationSec, out.durationSec)) {
        throw new Error(
          `burn output truncated (${out.durationSec ?? "?"}s vs source ${src.durationSec ?? "?"}s)`
        );
      }

      const hash = crypto.createHash("sha1").update(JSON.stringify(parsed.data)).digest("hex").slice(0, 8);
      const key = `supertext/${organizationId}/${mediaId}-${hash}.mp4`;
      const size = (await fsp.stat(outputPath)).size;
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: createReadStream(outputPath),
        ContentLength: size,
        ContentType: "video/mp4",
      }));
      const url = `${S3_BASE_URL}/${key}`;

      const derived = await prisma.media.create({
        data: {
          organizationId,
          uploadedById: post.createdById,
          fileName: `supertext-${media.fileName}`,
          fileType: "video/mp4",
          fileSize: size,
          url,
          width: out.width ?? width,
          height: out.height ?? height,
          duration: out.durationSec ? Math.round(out.durationSec) : media.duration,
          metadata: {
            superText: { sourceMediaId: mediaId, burnedAt: new Date().toISOString() },
            // Hand the derived file to the STANDARD optimize pipeline (IG
            // rendition etc.) exactly like a fresh upload.
            optimize: { status: "pending", enqueuedAt: new Date().toISOString() },
          } as any,
        },
      });
      await mediaOptimizeQueue
        .add("optimize", { mediaId: derived.id }, {
          jobId: `optimize:${derived.id}:v1`,
          attempts: 2,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 24 * 3600 },
        })
        .catch((e) => console.warn("[super-text] optimize enqueue failed:", e?.message ?? e));

      // Swap the post's attachment to the burned video (order preserved —
      // the join row keeps its `order`; only mediaId changes).
      await prisma.postMedia.updateMany({ where: { postId, mediaId }, data: { mediaId: derived.id } });

      results[mediaId] = { status: "done", derivedMediaId: derived.id };
      await stampSuperText(postId, { results }); // per-entry persistence → crash-safe retries
      burned++;

      await fsp.rm(stripPath, { force: true }).catch(() => undefined);
      await fsp.rm(inputPath, { force: true }).catch(() => undefined);
      await fsp.rm(outputPath, { force: true }).catch(() => undefined);
    }

    await stampSuperText(postId, { pendingBurn: false, completedAt: new Date().toISOString(), results });
    // Flip if every gate (incl. caption-fanout) is clear. Re-checked from a
    // FRESH read inside the helper — see publish-gates.ts race note.
    const flipped = await flipParkedPostIfReady(prisma as any, postId, organizationId);
    return { burned, skipped, flipped };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createSuperTextWorker() {
  const worker = new Worker<SuperTextBurnJobData>(
    QUEUE_NAMES.SUPER_TEXT,
    async (job: Job<SuperTextBurnJobData>) => runSuperTextBurn(job.data),
    {
      connection: createRedisConnection(),
      concurrency: 1, // one ffmpeg at a time on the 4-core box (same as media-optimize)
    }
  );
  worker.on("failed", (job, err) => {
    console.error(`[super-text] job ${job?.id} failed:`, err?.message ?? err);
    // Terminal failure → FAIL-VISIBLE (design decision #4). attemptsMade is
    // incremented before "failed" fires, so >= attempts means no retries left.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void markSuperTextFailed(job.data.postId, job.data.organizationId, err?.message ?? "unknown").catch(
        (e) => console.error("[super-text] markSuperTextFailed errored:", e)
      );
    }
  });
  return worker;
}
```

- [ ] **Step 2: Register the worker** — in `apps/worker/src/index.ts`, mirror the media-optimize lines exactly: add the import (`createSuperTextWorker`), a `registerWorker("super-text")` call in the block at lines 32+, an instantiation next to the other `createXWorker()` calls, and include it in the same shutdown collection the others use (read the bottom of the file to see whether workers are pushed into an array or closed individually — copy that pattern).

- [ ] **Step 3: Write worker tests** — `apps/worker/src/workers/__tests__/super-text.worker.test.ts` mocking `@postautomation/db` (prisma), `@postautomation/queue`, `@postautomation/ai` (launchCreativeBrowser → fake page/screenshot), `child_process` execFile, and S3 send. Lock:

```ts
// 1. Happy path: derived Media created with metadata.superText.sourceMediaId +
//    optimize pending stamp; optimize job enqueued with `optimize:<id>:v1`;
//    postMedia.updateMany swaps mediaId; superText.pendingBurn cleared;
//    flipParkedPostIfReady called → post flips when parkedSchedule && no caption gate.
// 2. Caption gate still pending → burn completes, pendingBurn cleared, post NOT flipped.
// 3. Retry idempotency: results[mediaId].status==="done" → the ffmpeg/S3/create
//    calls are NOT repeated for that entry.
// 4. Truncated output (mock output probe short) → job throws; markSuperTextFailed
//    on final attempt marks post FAILED + targets FAILED with SUPER_TEXT_FAIL_MESSAGE.
// 5. markSuperTextFailed is idempotent: pendingBurn already false → no writes.
// 6. Config entry for a media no longer attached → skipped, not fatal.
```
Write each as a real test using the same mocking utilities the caption-fanout worker tests use.

- [ ] **Step 4: Run tests** — `pnpm --filter @postautomation/worker test`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/workers/super-text.worker.ts apps/worker/src/workers/__tests__/super-text.worker.test.ts apps/worker/src/index.ts apps/worker/package.json pnpm-lock.yaml
git commit -m "feat(worker): super-text burn worker — derive media, swap attachments, gate flip"
```

---

### Task 7: caption-fanout flip respects the super-text gate

**Files:**
- Modify: `apps/worker/src/workers/caption-fanout.worker.ts` (`flipPendingFanoutPost`, lines 179–219)
- Modify/extend: the existing caption-fanout test file (find with `grep -rl "flipPendingFanoutPost" apps/worker/src`)

- [ ] **Step 1: Modify `flipPendingFanoutPost`** — replace the body after the guard at line 192 so a pending super-text burn defers the flip (behavior with NO superText metadata is byte-identical):

```ts
  if (post.status !== "DRAFT" || fanoutMeta.pendingSchedule !== true) return false;

  // Super-text gate: if the burn is still running, clear OUR flag but leave
  // the status flip to whichever gate clears LAST (flipParkedPostIfReady
  // re-reads fresh metadata, so a burn finishing between our read and write
  // can never strand the post).
  const superTextPending = (meta as Record<string, any>).superText?.pendingBurn === true;

  if (!superTextPending) {
    await deps.prisma.postTarget.updateMany({
      where: { postId, status: "DRAFT" },
      data: { status: "SCHEDULED" },
    });
  }
  await deps.prisma.post.update({
    where: { id: postId },
    data: {
      ...(superTextPending ? {} : { status: "SCHEDULED" }),
      metadata: {
        ...meta,
        captionFanout: {
          ...fanoutMeta,
          pendingSchedule: false,
          completedAt: new Date().toISOString(),
          ...(opts?.degraded
            ? { degraded: true, degradedAt: new Date().toISOString(), reason: DEGRADED_REASON }
            : {}),
        },
      },
    },
  });
  if (superTextPending) {
    // Post-write re-check closes the simultaneous-completion race.
    const { flipParkedPostIfReady } = await import("../lib/publish-gates");
    await flipParkedPostIfReady(deps.prisma as any, postId, organizationId);
    if (opts?.degraded) {
      await notifyDegradedFanout(deps, postId, organizationId, post.createdById);
    }
    return false;
  }
  if (opts?.degraded) {
    await notifyDegradedFanout(deps, postId, organizationId, post.createdById);
  }
  return true;
```

- [ ] **Step 2: Add tests** to the existing caption-fanout suite:

```ts
// 1. metadata.superText.pendingBurn=true → flipPendingFanoutPost clears
//    captionFanout.pendingSchedule but does NOT set post/targets SCHEDULED itself.
// 2. Same call when superText.pendingBurn=false (burn finished between read/write is
//    simulated by the mocked findFirst inside flipParkedPostIfReady returning cleared
//    metadata) → flipParkedPostIfReady DOES flip.
// 3. No superText metadata at all → flip behavior identical to the pre-change tests
//    (the existing assertions must pass UNCHANGED).
```

- [ ] **Step 3: Run** — `pnpm --filter @postautomation/worker test -- caption-fanout`
Expected: PASS, including every pre-existing assertion.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/workers/caption-fanout.worker.ts apps/worker/src/workers/__tests__
git commit -m "feat(worker): caption-fanout flip defers to pending super-text gate"
```

---

### Task 8: Worker image fonts (emoji + Arial-metric sans)

**Files:**
- Modify: `docker/Dockerfile.worker` (the `apk add` block, lines ~7–11)

- [ ] **Step 1:** Append `ttf-liberation font-noto font-noto-emoji` to the existing runtime `apk add` package list (same line as `ttf-freefont`). Do NOT remove any existing package.
  - `font-noto-emoji` = Noto Color Emoji → Chromium renders 😍✨ in the strip PNG (today the image has NO emoji font — tofu).
  - `ttf-liberation` = Liberation Sans, metric-compatible with the preview's Arial → identical wrap points.
- [ ] **Step 2:** Sanity-build locally if Docker is available: `docker build -f docker/Dockerfile.worker -t supertext-font-test . --target` (or just the first stage); otherwise verify the package names exist: `docker run --rm alpine:3.20 sh -c "apk info -e ttf-liberation font-noto font-noto-emoji || apk search -x ttf-liberation font-noto font-noto-emoji"`.
- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile.worker
git commit -m "feat(worker): color-emoji + Arial-metric fonts for super-text strip rendering"
```

---

### Task 9: Web — `SuperTextStrip` preview + `SuperTextEditor` dialog

**Files:**
- Create: `apps/web/components/content-agent/super-text-strip.tsx`
- Create: `apps/web/components/content-agent/SuperTextEditor.tsx`
- Modify: `apps/web/package.json` (add `"@postautomation/super-text": "workspace:*"`)

- [ ] **Step 1: The shared strip preview component**

`apps/web/components/content-agent/super-text-strip.tsx`:

```tsx
"use client";

import { buildStripInnerHtml, STRIP_MAX_WIDTH_PCT, type SuperTextConfig } from "@postautomation/super-text";

/**
 * Live preview of the burned strip. Renders the EXACT builder output the
 * worker burns (REP-4 lesson: one rendering source of truth). The builder
 * escapes all text and hex-validates all colors, so the injected HTML is safe.
 * Purely presentational — pointer events handled by the parent (drag).
 */
export function SuperTextStrip({
  config,
  stageWidth,
}: {
  config: SuperTextConfig;
  stageWidth: number;
}) {
  const fontPx = (config.fontSizePct / 100) * stageWidth;
  return (
    <div
      style={{
        position: "absolute",
        left: `${config.xPct}%`,
        top: `${config.yPct}%`,
        transform: "translate(-50%,-50%)",
        maxWidth: `${STRIP_MAX_WIDTH_PCT}%`,
        textAlign: "center",
        fontSize: `${fontPx}px`,
        pointerEvents: "none",
      }}
      dangerouslySetInnerHTML={{ __html: buildStripInnerHtml(config) }}
    />
  );
}
```

- [ ] **Step 2: The editor dialog**

`apps/web/components/content-agent/SuperTextEditor.tsx` — a `Dialog` (import from `~/components/ui/dialog`, matching ComposeTab's other dialogs; remember the `~/` alias — `@/` does not exist in apps/web). Full component:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Film } from "lucide-react";
import {
  superTextConfigSchema,
  SUPER_TEXT_DEFAULTS,
  FONT_SIZE_PRESETS,
  type SuperTextConfig,
} from "@postautomation/super-text";
import { withPosterHint } from "~/lib/video-poster";
import { SuperTextStrip } from "./super-text-strip";

const TILE_VIDEO_PREVIEW_MAX_BYTES = 256 * 1024 * 1024; // mirror ComposeTab's rule

const WORD_SWATCHES = ["#FFFFFF", "#FDE047", "#F87171", "#4ADE80", "#60A5FA", "#F472B6", "#FB923C"];

export function SuperTextEditor({
  open,
  onOpenChange,
  videoUrl,
  videoFile,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoUrl: string;
  videoFile?: File;
  initial: SuperTextConfig | null;
  onSave: (config: SuperTextConfig | null) => void;
}) {
  const [text, setText] = useState(() => (initial ? initial.segments.map((s) => s.text).join(" ") : ""));
  const [wordColors, setWordColors] = useState<Record<number, string | undefined>>(() => {
    const map: Record<number, string | undefined> = {};
    initial?.segments.forEach((s, i) => { if (s.color) map[i] = s.color; });
    return map;
  });
  const [selectedWord, setSelectedWord] = useState<number | null>(null);
  const [stripColor, setStripColor] = useState(initial?.stripColor ?? SUPER_TEXT_DEFAULTS.stripColor);
  const [textColor, setTextColor] = useState(initial?.textColor ?? SUPER_TEXT_DEFAULTS.textColor);
  const [fontSizePct, setFontSizePct] = useState(initial?.fontSizePct ?? SUPER_TEXT_DEFAULTS.fontSizePct);
  const [xPct, setXPct] = useState(initial?.xPct ?? SUPER_TEXT_DEFAULTS.xPct);
  const [yPct, setYPct] = useState(initial?.yPct ?? SUPER_TEXT_DEFAULTS.yPct);
  const [aspect, setAspect] = useState<number | null>(null); // width/height
  const [stageWidth, setStageWidth] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // Words derive from the text — colors are keyed by word index (v1: a text
  // edit that shifts word positions shifts colors with it; acceptable).
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);

  // Large LOCAL files never get a media element (OOM rule) — probe aspect via a
  // short-lived metadata-only element, released the moment metadata arrives
  // (same pattern as ComposeTab's aspect probe; keyed on the URL STRING).
  const skipInlineVideo = !!videoFile && videoFile.size > TILE_VIDEO_PREVIEW_MAX_BYTES;
  useEffect(() => {
    if (!open || !videoUrl) return;
    let el: HTMLVideoElement | null = document.createElement("video");
    el.preload = "metadata";
    el.muted = true;
    const release = () => {
      if (!el) return;
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute("src");
      el.load();
      el = null;
    };
    el.onloadedmetadata = () => {
      if (el && el.videoWidth && el.videoHeight) setAspect(el.videoWidth / el.videoHeight);
      release();
    };
    el.onerror = release;
    el.src = videoUrl;
    return release;
  }, [open, videoUrl]);

  // Track the rendered stage width for font scaling (percentage-of-width).
  useEffect(() => {
    if (!open) return;
    const node = stageRef.current;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setStageWidth(w);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [open, aspect]);

  const buildConfig = (): SuperTextConfig | null => {
    if (words.length === 0) return null;
    const candidate = {
      version: 1 as const,
      segments: words.map((w, i) => ({ text: w, ...(wordColors[i] ? { color: wordColors[i] } : {}) })),
      stripColor,
      textColor,
      xPct,
      yPct,
      fontSizePct,
    };
    const parsed = superTextConfigSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  };
  const previewConfig = useMemo(buildConfig, [words, wordColors, stripColor, textColor, xPct, yPct, fontSizePct]);

  const onStagePointer = (e: React.PointerEvent) => {
    if (!draggingRef.current || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    setXPct(Math.min(95, Math.max(5, ((e.clientX - rect.left) / rect.width) * 100)));
    setYPct(Math.min(95, Math.max(5, ((e.clientY - rect.top) / rect.height) * 100)));
  };

  const stageAspect = aspect ?? 9 / 16;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Super text</DialogTitle>
        </DialogHeader>

        {/* Stage: video (or placeholder) + draggable strip */}
        <div
          ref={stageRef}
          className="relative mx-auto w-full max-w-[320px] touch-none select-none overflow-hidden rounded-lg bg-zinc-900"
          style={{ aspectRatio: `${stageAspect}` }}
          onPointerDown={(e) => {
            draggingRef.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            onStagePointer(e);
          }}
          onPointerMove={onStagePointer}
          onPointerUp={() => { draggingRef.current = false; }}
        >
          {!skipInlineVideo ? (
            <video
              src={withPosterHint(videoUrl)}
              muted
              playsInline
              preload="metadata"
              className="pointer-events-none h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-zinc-500">
              <Film className="h-10 w-10" />
            </div>
          )}
          {previewConfig && stageWidth > 0 && (
            <SuperTextStrip config={previewConfig} stageWidth={stageWidth} />
          )}
        </div>
        <p className="text-xs text-muted-foreground text-center">Drag on the video to position the text.</p>

        {/* Text (native keyboard emoji work here: 😍✨) */}
        <Input
          value={text}
          onChange={(e) => setText(e.target.value.replace(/\n/g, " ").slice(0, 150))}
          placeholder="Type your super text… (emoji welcome 😍)"
        />

        {/* Per-word colors: tap a word, then a swatch */}
        {words.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {words.map((w, i) => (
                <button
                  key={`${i}-${w}`}
                  type="button"
                  onClick={() => setSelectedWord(selectedWord === i ? null : i)}
                  className={`rounded px-1.5 py-0.5 text-xs font-semibold border ${selectedWord === i ? "border-primary ring-1 ring-primary" : "border-transparent bg-muted"}`}
                  style={wordColors[i] ? { color: wordColors[i] } : undefined}
                >
                  {w}
                </button>
              ))}
            </div>
            {selectedWord != null && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="rounded border px-1.5 py-0.5 text-xs"
                  onClick={() => setWordColors((p) => ({ ...p, [selectedWord]: undefined }))}
                >
                  Default
                </button>
                {WORD_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Color ${c}`}
                    className="h-5 w-5 rounded-full border"
                    style={{ background: c }}
                    onClick={() => setWordColors((p) => ({ ...p, [selectedWord]: c }))}
                  />
                ))}
                <input
                  type="color"
                  aria-label="Custom word color"
                  className="h-6 w-8 cursor-pointer"
                  value={wordColors[selectedWord] ?? textColor}
                  onChange={(e) => setWordColors((p) => ({ ...p, [selectedWord]: e.target.value }))}
                />
              </div>
            )}
          </div>
        )}

        {/* Strip + text colors, size presets */}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            Strip
            <input type="color" value={stripColor} onChange={(e) => setStripColor(e.target.value)} className="h-6 w-8 cursor-pointer" />
          </label>
          <label className="flex items-center gap-1.5">
            Text
            <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="h-6 w-8 cursor-pointer" />
          </label>
          <div className="flex items-center gap-1">
            {(Object.keys(FONT_SIZE_PRESETS) as Array<keyof typeof FONT_SIZE_PRESETS>).map((k) => (
              <Button
                key={k}
                type="button"
                size="sm"
                variant={fontSizePct === FONT_SIZE_PRESETS[k] ? "default" : "outline"}
                onClick={() => setFontSizePct(FONT_SIZE_PRESETS[k])}
              >
                {k}
              </Button>
            ))}
          </div>
        </div>

        <DialogFooter className="gap-2">
          {initial && (
            <Button type="button" variant="destructive" onClick={() => onSave(null)}>
              Remove
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!previewConfig} onClick={() => previewConfig && onSave(previewConfig)}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```
(Verify the exact `Dialog`/`Button`/`Input` export names against another ComposeTab dialog import before building; adjust variants if the ui kit differs.)

- [ ] **Step 3: Verify it compiles** — `pnpm --filter @postautomation/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/content-agent/super-text-strip.tsx apps/web/components/content-agent/SuperTextEditor.tsx apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): super-text editor dialog + shared strip preview"
```

---

### Task 10: ComposeTab + draft persistence wiring

**Files:**
- Modify: `apps/web/components/content-agent/ComposeTab.tsx` (state line 123, tile block ~1246–1265, draft signature 240, draft persist 251–268, restore ~205–215, submit ~930–941, save-as-draft ~1685–1700)
- Modify: `apps/web/lib/active-task.tsx` (draft.media item type, lines 12–19)

- [ ] **Step 1: Types + state.** In ComposeTab:
  - Add `import { type SuperTextConfig } from "@postautomation/super-text";` and `import { SuperTextEditor } from "./SuperTextEditor";` and the `Type` icon to the existing `lucide-react` import.
  - Extend the state type at line 123: `useState<{ url: string; mediaId?: string; file?: File; uploading?: boolean; progress?: number; superText?: SuperTextConfig }[]>([])`.
  - Add `const [superTextEditIndex, setSuperTextEditIndex] = useState<number | null>(null);`

In `apps/web/lib/active-task.tsx` line ~18, widen the draft media item:

```ts
    /** Restorable attachments: items with a Media row id or a non-blob URL. */
    media?: { url: string; mediaId?: string; superText?: unknown }[];
```
(`unknown` keeps the provider package-agnostic; ComposeTab validates on restore.)

- [ ] **Step 2: Tile button + badge.** Inside the `postMedia.map` tile render (~1246–1265), in the video branch (`isVideoMediaItem(item)`), add next to the tile's existing controls (match their styling/visibility classes, including the `[@media(hover:hover)]` always-visible-on-touch pattern):

```tsx
<button
  type="button"
  aria-label={item.superText ? "Edit super text" : "Add super text"}
  className="absolute bottom-1 left-1 rounded bg-black/60 p-1 text-white"
  onClick={(e) => { e.stopPropagation(); setSuperTextEditIndex(index); }}
>
  <Type className="h-3.5 w-3.5" />
</button>
{item.superText && (
  <span className="absolute bottom-1 right-1 rounded bg-primary/90 px-1 text-[10px] font-semibold text-primary-foreground">
    Super text
  </span>
)}
```

And render the dialog once, near the other dialogs at the bottom of the component:

```tsx
{superTextEditIndex != null && postMedia[superTextEditIndex] && (
  <SuperTextEditor
    open
    onOpenChange={(o) => { if (!o) setSuperTextEditIndex(null); }}
    videoUrl={postMedia[superTextEditIndex].url}
    videoFile={postMedia[superTextEditIndex].file}
    initial={postMedia[superTextEditIndex].superText ?? null}
    onSave={(cfg) => {
      setPostMedia((prev) =>
        prev.map((m, i) => (i === superTextEditIndex ? { ...m, superText: cfg ?? undefined } : m))
      );
      setSuperTextEditIndex(null);
    }}
  />
)}
```

- [ ] **Step 3: Draft signature + persist + restore.**
  - Line 240: `JSON.stringify(postMedia.map((m) => [m.url, m.mediaId ?? null, m.superText ?? null]))` — the persist effect must re-fire on super-text edits (the effect stays keyed on the signature; NEVER `[postMedia]`).
  - Persist map (line ~266): `.map(({ url, mediaId, superText }) => ({ url, mediaId, ...(superText ? { superText } : {}) }))`
  - Restore (line ~207): `media.map(({ url, mediaId, superText }: any) => ({ url, mediaId, ...(superText ? { superText } : {}) }))` — then validate on submit via the schema (invalid restored configs are silently dropped at config-build time in Step 4's zip, because `post.create` would reject them; run `superTextConfigSchema.safeParse` in the zip and skip failures).

- [ ] **Step 4: Submit payload.** In `handleSubmit` after `const mediaIds = await resolvePostMediaIds();` (~line 921) — `mediaIds[i]` is order-aligned with `postMedia[i]` (the resolver pushes exactly one id per item or throws):

```ts
      // Super text: key each config by its RESOLVED media id (order-aligned).
      const superTextByMediaId: Record<string, SuperTextConfig> = {};
      postMedia.forEach((m, i) => {
        const id = mediaIds[i];
        if (!m.superText || !id) return;
        const parsed = superTextConfigSchema.safeParse(m.superText); // guards stale restored drafts
        if (parsed.success) superTextByMediaId[id] = parsed.data;
      });
```
(add `superTextConfigSchema` to the package import) and replace the metadata spread (line ~940):

```ts
        ...(() => {
          const md = {
            ...ytMetadata,
            ...(Object.keys(superTextByMediaId).length > 0 ? { superText: superTextByMediaId } : {}),
          };
          return Object.keys(md).length > 0 ? { metadata: md } : {};
        })(),
```
Apply the same zip+metadata pattern to the inline "Save as Draft" submit (~1685–1700) so drafts carry (and start burning) super text too.

- [ ] **Step 5: Verify manually + compile.**
  - `pnpm --filter @postautomation/web exec tsc --noEmit` → exit 0.
  - `pnpm dev`, attach a small mp4 in Compose → tile shows the Type button → editor opens, text+emoji+word colors+drag work, Apply shows the badge → schedule the post to a token-based channel (e.g. Telegram) → post parks DRAFT, worker burns, post flips SCHEDULED and publishes the burned video.
  - Attach an image → NO super-text button. Post without super text → payload has no `metadata.superText` (verify in devtools network tab).

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/content-agent/ComposeTab.tsx apps/web/lib/active-task.tsx
git commit -m "feat(web): compose super-text wiring — tile entry, drafts, submit payload"
```

---

### Task 11: Full verification + acceptance burn on the reference video

- [ ] **Step 1:** `pnpm test` → all green (incl. golden-render gate 17/17 untouched, caption-fanout suite, app-role-gating).
- [ ] **Step 2:** `pnpm type-check` → exit 0.
- [ ] **Step 3:** `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` → exit 0 (the mandatory next-build check — SWC rejects things tsc allows).
- [ ] **Step 4: Acceptance burn (scriptable, no UI needed).** Write a scratch script that imports `buildSuperTextFrameHtml` + `buildSuperTextCompositeArgs`, renders the strip for `~/Downloads/99A1BF80-7613-4320-BF27-D31F2A1E3CD9.MP4` (720×1280) with segments `Ranveer with his real life Yalina😍✨` at `yPct: 72`, runs ffmpeg, then extracts a frame (`ffmpeg -ss 5 -i out.mp4 -frames:v 1 frame.png`) and visually verify: white pill strip, bold black text, color emoji, position matching the reference. Duration probe of the output within 2% of 18.39s.
- [ ] **Step 5:** Byte-identical spot-check for normal posting: create a post WITHOUT super text via the UI against local; confirm the created row's `metadata` and status match a pre-branch checkout run (or rely on the Task-4 regression test + untouched existing suites).
- [ ] **Step 6:** Final commit + PR

```bash
git checkout -b feat/super-text-video-overlay-2026-07-27  # (do this at Task 1 if not already on a branch)
git push -u origin feat/super-text-video-overlay-2026-07-27
gh pr create --title "feat: Super Text — IG-style video text strip (emoji, per-word colors, draggable), burned once, published everywhere" --body "..."
```

---

## Deployment notes

- The worker image must be rebuilt (fonts + new worker) — the standard `bash scripts/deploy.sh deploy` rebuilds all three containers; nothing special needed.
- No env vars required; optional tuning: `SUPER_TEXT_TIMEOUT_MS`.
- No DB migration.
- Feature is fully additive: absent `metadata.superText` keeps every path byte-identical (locked by Task-4 test #4).

## Self-review checklist (run after writing code)
1. Every requirement covered: optional strip ✔ emoji ✔ per-word colors ✔ draggable position with preview ✔ multi-channel ✔ normal posting untouched ✔.
2. No effect keyed on `postMedia` identity; probe element released on metadata; no `<img>` with a video URL; blob >256MB → placeholder stage.
3. Job ids: `supertext:{postId}:v1` and `optimize:{id}:v1` (3 colon segments), caption-fanout id untouched.
4. `Number(fileSize)` at every BigInt read.
5. IG/FB publish paths untouched; watermark overlay still applies to the burned video exactly as it does to any video today.
