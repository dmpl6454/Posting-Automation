# Super Agent + Content Studio (Repurpose) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Super Agent see/use uploaded media end-to-end, and fix Content Studio Repurpose (carousel publishing, a 4-style creative renderer, brand-reference templates, social-URL ingestion, and the video-format menu).

**Architecture:** Two isolated boundaries. (1) A **creative renderer** in `packages/ai` — pure `opts → HTML → PNG` builders, one per style, behind `buildStaticCreative(style, opts)`; the repurpose router stays style-agnostic. (2) **Creative templates** — a thin Prisma + tRPC storage layer that pre-fills the renderer's brand inputs. Super Agent fixes are independent and touch only the chat stream route, chat-agent chain, Gemini provider, chat router action payloads, and the prompt.

**Tech Stack:** Next.js (App Router), tRPC, Prisma + Postgres, LangChain (`@langchain/core@0.3.80`, ChatOpenAI/ChatAnthropic), `@google/generative-ai@0.24.1` (Gemini), Puppeteer (creative rendering), Vitest, pnpm workspaces, S3/MinIO.

**Spec:** [docs/superpowers/specs/2026-06-09-super-agent-content-studio-design.md](../specs/2026-06-09-super-agent-content-studio-design.md)
**Audit:** [docs/audit/2026-06-09-super-agent-content-studio-audit.md](../../audit/2026-06-09-super-agent-content-studio-audit.md)

**Conventions:** pnpm only (NOT npm). Run tests with `pnpm --filter @postautomation/ai test` or `pnpm --filter @postautomation/api test`. Commit after each task. Keep all existing gates (`assertChannelsOwned`, `enforcePlanLimit`, `requirePlan(..., ctx.isSuperAdmin)`).

---

## Phase ordering rationale
Module B (Repurpose) is split so the **pure, unit-testable** pieces come first (entity decoder, creative renderer) — they have no DB/network deps and lock down the hardest visual work behind tests. Then the router wiring (carousel Media rows, social headline). Then the new Prisma model + template router. Then the UI. Module A (Super Agent) is last because its acceptance is mostly live-verified (vision), though the provider-fallback fix is unit-testable.

---

# MODULE B — Content Studio / Repurpose

## Task 1: HTML-entity decoder (fixes social-URL garbling B6.1)

**Files:**
- Modify: `packages/ai/src/utils/url-extractor.ts`
- Test: `packages/ai/src/__tests__/decode-entities.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/ai/src/__tests__/decode-entities.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { decodeEntities } from "../utils/url-extractor";

describe("decodeEntities", () => {
  it("decodes named entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &quot;quote&quot; it&#39;s")).toBe(
      `Tom & Jerry "quote" it's`
    );
  });
  it("decodes numeric decimal entities", () => {
    expect(decodeEntities("don&#8217;t stop")).toBe("don’t stop");
  });
  it("decodes hex entities including emoji", () => {
    // &#x1f37f; = 🍿 popcorn, &#x2019; = ’ right single quote
    expect(decodeEntities("&#x1f37f; June&#x2019;s OTT")).toBe("\u{1f37f} June’s OTT");
  });
  it("handles &lt; &gt; &nbsp;", () => {
    expect(decodeEntities("a &lt;b&gt;&nbsp;c")).toBe("a <b> c");
  });
  it("leaves plain text untouched", () => {
    expect(decodeEntities("plain text")).toBe("plain text");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/ai test decode-entities`
Expected: FAIL — `decodeEntities` is not exported.

- [ ] **Step 3: Implement `decodeEntities` and export it**

In `packages/ai/src/utils/url-extractor.ts`, add this exported function near `stripHtml` (top of the helpers area, after the `USER_AGENT` constants):

```typescript
/** Decode HTML entities (named + numeric decimal + hex, incl. emoji) so raw
 *  `&quot;`/`&#x1f37f;`/`&#8217;` never reach the creative template. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  hellip: "…", mdash: "—", ndash: "–", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(input: string): string {
  if (!input) return input;
  return input
    // hex: &#x1f37f;
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _m; }
    })
    // decimal: &#8217;
    .replace(/&#(\d+);/g, (_m, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _m; }
    })
    // named: &amp; &quot; ...
    .replace(/&([a-zA-Z]+);/g, (_m, name) => NAMED_ENTITIES[name] ?? _m);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/ai test decode-entities`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/utils/url-extractor.ts packages/ai/src/__tests__/decode-entities.test.ts
git commit -m "feat(ai): add HTML-entity decoder for URL extraction"
```

---

## Task 2: Apply `decodeEntities` at the extraction boundary (B6.1)

**Files:**
- Modify: `packages/ai/src/utils/url-extractor.ts` (`getMeta`, `getTitle`, `stripHtml`)
- Test: `packages/ai/src/__tests__/extract-decode.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/ai/src/__tests__/extract-decode.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { __test__ } from "../utils/url-extractor";

// __test__ exposes getMeta / getTitle for unit testing (added in this task).
describe("getMeta/getTitle decode entities", () => {
  it("decodes og:title entities", () => {
    const html = `<meta property="og:title" content="June&#x2019;s OTT &quot;hits&quot;">`;
    expect(__test__.getMeta(html, "og:title")).toBe("June’s OTT \"hits\"");
  });
  it("decodes <title> entities", () => {
    const html = `<title>Tom &amp; Jerry</title>`;
    expect(__test__.getTitle(html)).toBe("Tom & Jerry");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/ai test extract-decode`
Expected: FAIL — `__test__` is not exported.

- [ ] **Step 3: Decode in `getMeta`/`getTitle`/`stripHtml` and expose a test hook**

In `packages/ai/src/utils/url-extractor.ts`:

(a) In `getMeta`, wrap the returned match with `decodeEntities`:

```typescript
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1]);
  }
  return "";
```

(b) In `getTitle`, decode the `<title>` fallback (the og:/twitter: branches already go through the now-decoding `getMeta`):

```typescript
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeEntities(match?.[1]?.trim() || "");
```

(c) In `stripHtml`, replace the hand-rolled entity replacements with the shared decoder. Change the tail of `stripHtml` from the `.replace(/&nbsp;/g, " ")...` chain to:

```typescript
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeEntities(stripped);
```

Concretely, refactor `stripHtml` to build a `stripped` string then `return decodeEntities(stripped)`:

```typescript
function stripHtml(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeEntities(stripped);
}
```

(d) At the very bottom of the file, add the test hook:

```typescript
/** @internal test-only access to private extractors */
export const __test__ = { getMeta, getTitle, stripHtml };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/ai test extract-decode`
Expected: PASS (2 tests). Also run the existing extractor tests to ensure no regression: `pnpm --filter @postautomation/ai test url` (or `topic-extractor`).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/utils/url-extractor.ts packages/ai/src/__tests__/extract-decode.test.ts
git commit -m "fix(ai): decode HTML entities in getMeta/getTitle/stripHtml at extraction boundary"
```

---

## Task 3: Creative renderer — shared types + dispatcher skeleton (B2)

**Files:**
- Create: `packages/ai/src/tools/creative-templates.ts`
- Test: `packages/ai/src/__tests__/creative-templates.test.ts` (create)

This task defines the `StaticCreativeOptions` type, the `CreativeStyle` union, and `buildStaticCreative(style, opts)` returning an HTML string. The four style builders are filled in Tasks 4–7 (start with `premium_editorial` implemented, the others throwing "not implemented" so the dispatcher type-checks).

- [ ] **Step 1: Write the failing test**

Create `packages/ai/src/__tests__/creative-templates.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildStaticCreative, type StaticCreativeOptions } from "../tools/creative-templates";

const base: StaticCreativeOptions = {
  style: "premium_editorial",
  headline: "Krrish 4 Budget Controversy Debunked",
  channelName: "Moviefied",
  handle: "@moviefied",
  logoPosition: "top-right",
};

describe("buildStaticCreative", () => {
  it("renders premium_editorial with headline + channel + escaped HTML", () => {
    const html = buildStaticCreative({ ...base });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Krrish 4 Budget Controversy Debunked");
    expect(html).toContain("Moviefied");
    expect(html).toContain("width:1080px");
    expect(html).toContain("height:1350px");
  });
  it("escapes HTML-special chars in the headline (no injection)", () => {
    const html = buildStaticCreative({ ...base, headline: `A <b>"x"</b> & y` });
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<b>\"x\"</b>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/ai test creative-templates`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the renderer with shared helpers + dispatcher (premium implemented)**

Create `packages/ai/src/tools/creative-templates.ts`:

```typescript
/**
 * Social creative renderer. Pure `opts → HTML` builders, one per style, behind
 * a single dispatcher. Rendered to PNG by news-image-generator via Puppeteer.
 * Inputs are shared across styles; only layout differs.
 */

export type CreativeStyle =
  | "premium_editorial"
  | "hook_bars"
  | "tweet_card"
  | "bold_typographic";

export interface StaticCreativeOptions {
  style: CreativeStyle;
  headline: string;
  /** Optional punchy hook line (hook_bars). Supports **word** highlight markup. */
  hookLine?: string;
  subhead?: string;
  /** Background/primary photo as a data URL or http(s) URL. */
  bgImageUrl?: string;
  /** Optional second image (hook_bars inset cutout; tweet_card image pair). */
  secondaryImageUrl?: string;
  /** Logo URL; null/undefined → logo block omitted (no-reference path). */
  logoUrl?: string | null;
  logoPosition: "top-left" | "top-right";
  /** Brand accent color (hex). Defaults applied per style if absent. */
  brandColor?: string;
  channelName: string;
  handle?: string;
  verified?: boolean;
  tag?: string;
  date?: string;
}

const CANVAS = { width: 1080, height: 1350 };
const DEFAULT_ACCENT = "#e11d48";

export function escapeHtml(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert **word** / ==word== markup to brand-accent <span>s, escaping the rest. */
export function renderHighlightMarkup(text: string, accent: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, `<span style="color:${accent}">$1</span>`)
    .replace(/==([^=]+)==/g, `<span style="color:${accent}">$1</span>`);
}

function fmtDate(date?: string): string {
  return (
    date ??
    new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase()
  );
}

/** Word-count-aware headline font size (px) within the 1080px canvas. */
function headlineFontSize(headline: string): number {
  const words = headline.trim().split(/\s+/).length;
  return words <= 5 ? 82 : words <= 8 ? 66 : words <= 12 ? 54 : words <= 16 ? 46 : 40;
}

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');`;

function logoHtml(opts: StaticCreativeOptions, size: number): string {
  const accent = opts.brandColor || DEFAULT_ACCENT;
  if (opts.logoUrl) {
    return `<img src="${escapeHtml(opts.logoUrl)}" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;object-fit:contain;background:rgba(255,255,255,0.06);" />`;
  }
  const initial = (opts.channelName[0] ?? "N").toUpperCase();
  return `<div style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;background:${accent};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:${Math.round(size * 0.42)}px;">${initial}</div>`;
}

// ── Style builders ────────────────────────────────────────────────────────
function buildPremiumEditorial(opts: StaticCreativeOptions): string {
  const accent = opts.brandColor || DEFAULT_ACCENT;
  const fs = headlineFontSize(opts.headline);
  const bg = opts.bgImageUrl
    ? `background-image:url(${opts.bgImageUrl});background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,#1a1a2e,#16213e);`;
  const corner = opts.logoPosition === "top-left" ? "left:48px;" : "right:48px;";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden;position:relative;font-family:'Inter',system-ui,sans-serif;background:#000;-webkit-font-smoothing:antialiased;}
.bg{position:absolute;inset:0;${bg}}
.scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.92) 0%,rgba(0,0,0,0.55) 40%,rgba(0,0,0,0.15) 70%,rgba(0,0,0,0.35) 100%);}
.logo{position:absolute;top:44px;${corner}}
.block{position:absolute;left:56px;right:56px;bottom:96px;}
.label{font-style:italic;font-size:26px;font-weight:600;color:rgba(255,255,255,0.92);letter-spacing:0.01em;}
.rule{width:64px;height:4px;background:${accent};border-radius:2px;margin:14px 0 22px;}
.headline{color:#fff;font-size:${fs}px;font-weight:800;line-height:1.08;letter-spacing:-0.02em;word-break:break-word;}
.handle{position:absolute;bottom:44px;left:56px;color:rgba(255,255,255,0.6);font-size:20px;font-weight:500;}
</style></head><body>
<div class="bg"></div><div class="scrim"></div>
<div class="logo">${logoHtml(opts, 64)}</div>
<div class="block">
  <div class="label">${escapeHtml(opts.channelName)}</div>
  <div class="rule"></div>
  <div class="headline">${escapeHtml(opts.headline)}</div>
</div>
${opts.handle ? `<div class="handle">${escapeHtml(opts.handle)}</div>` : ""}
</body></html>`;
}

function notImplemented(style: string): never {
  throw new Error(`creative style "${style}" not implemented yet`);
}

export function buildStaticCreative(opts: StaticCreativeOptions): string {
  switch (opts.style) {
    case "premium_editorial":
      return buildPremiumEditorial(opts);
    case "hook_bars":
      return notImplemented("hook_bars");
    case "tweet_card":
      return notImplemented("tweet_card");
    case "bold_typographic":
      return notImplemented("bold_typographic");
    default:
      return buildPremiumEditorial(opts);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/ai test creative-templates`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/tools/creative-templates.ts packages/ai/src/__tests__/creative-templates.test.ts
git commit -m "feat(ai): creative renderer skeleton + premium_editorial style"
```

---

## Task 4: `hook_bars` style (TMC/Pushpa reference)

**Files:**
- Modify: `packages/ai/src/tools/creative-templates.ts`
- Test: `packages/ai/src/__tests__/creative-templates.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `creative-templates.test.ts`:

```typescript
describe("hook_bars style", () => {
  it("renders both bars + highlight markup + optional inset", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "TMC's Jahangir Khan arrested near Nepal border",
      hookLine: "TMC ka **Pushpa** kaise jhukega nahi 🚨",
      channelName: "NewsPage",
      brandColor: "#e11d48",
      logoPosition: "top-right",
      bgImageUrl: "data:image/png;base64,AAAA",
      secondaryImageUrl: "data:image/png;base64,BBBB",
    });
    expect(html).toContain("Nepal border");
    // highlight markup became an accent span
    expect(html).toContain(`color:#e11d48`);
    expect(html).toContain("Pushpa");
    // inset cutout present when secondaryImageUrl provided
    expect(html).toContain("data:image/png;base64,BBBB");
  });
  it("omits inset when no secondaryImageUrl", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "Headline only",
      hookLine: "Hook!",
      channelName: "NewsPage",
      logoPosition: "top-right",
    });
    expect(html).not.toContain("inset-cutout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/ai test creative-templates`
Expected: FAIL — `hook_bars` throws "not implemented".

- [ ] **Step 3: Implement `buildHookBars` and wire it into the dispatcher**

In `creative-templates.ts`, add the builder above `notImplemented`:

```typescript
function buildHookBars(opts: StaticCreativeOptions): string {
  const accent = opts.brandColor || DEFAULT_ACCENT;
  const bg = opts.bgImageUrl
    ? `background-image:url(${opts.bgImageUrl});background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,#222,#111);`;
  const corner = opts.logoPosition === "top-left" ? "left:40px;" : "right:40px;";
  const hookHtml = opts.hookLine ? renderHighlightMarkup(opts.hookLine, accent) : "";
  const inset = opts.secondaryImageUrl
    ? `<img class="inset-cutout" src="${opts.secondaryImageUrl}" style="position:absolute;bottom:330px;right:60px;width:300px;height:300px;border-radius:50%;object-fit:cover;border:6px solid #fff;box-shadow:0 8px 30px rgba(0,0,0,0.5);" />`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden;position:relative;font-family:'Inter',system-ui,sans-serif;background:#000;}
.bg{position:absolute;inset:0;${bg}}
.logo{position:absolute;top:36px;${corner}}
.bars{position:absolute;left:36px;right:36px;bottom:48px;display:flex;flex-direction:column;gap:14px;}
.bar{background:#fff;border-radius:10px;padding:18px 24px;box-shadow:0 6px 24px rgba(0,0,0,0.35);}
.hook{font-size:40px;font-weight:800;line-height:1.15;color:#111;}
.headline{font-size:44px;font-weight:800;line-height:1.12;color:#111;}
.headline .accent{color:${accent};}
</style></head><body>
<div class="bg"></div>
<div class="logo">${logoHtml(opts, 56)}</div>
${inset}
<div class="bars">
  ${hookHtml ? `<div class="bar"><div class="hook">${hookHtml}</div></div>` : ""}
  <div class="bar"><div class="headline">${escapeHtml(opts.headline)}</div></div>
</div>
</body></html>`;
}
```

Update the dispatcher:

```typescript
    case "hook_bars":
      return buildHookBars(opts);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/ai test creative-templates`
Expected: PASS (hook_bars tests + earlier ones).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/tools/creative-templates.ts packages/ai/src/__tests__/creative-templates.test.ts
git commit -m "feat(ai): hook_bars creative style"
```

---

## Task 5: `tweet_card` style (Conrad Fisher reference)

**Files:**
- Modify: `packages/ai/src/tools/creative-templates.ts`
- Test: `packages/ai/src/__tests__/creative-templates.test.ts`

- [ ] **Step 1: Add the failing test**

Append:

```typescript
describe("tweet_card style", () => {
  it("renders brand name, handle, verified tick, text, and image pair", () => {
    const html = buildStaticCreative({
      style: "tweet_card",
      headline: "Garret this, Dean that... Honestly i just want Conrad Fisher back!!!",
      channelName: "Moviefied Bollywood",
      handle: "@moviefiedbollywood",
      verified: true,
      logoPosition: "top-left",
      bgImageUrl: "data:image/png;base64,AAAA",
      secondaryImageUrl: "data:image/png;base64,BBBB",
    });
    expect(html).toContain("Moviefied Bollywood");
    expect(html).toContain("@moviefiedbollywood");
    expect(html).toContain("Conrad Fisher back");
    expect(html).toContain("verified-tick");
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,BBBB");
  });
  it("omits verified tick when verified is false", () => {
    const html = buildStaticCreative({
      style: "tweet_card",
      headline: "x",
      channelName: "Brand",
      handle: "@brand",
      logoPosition: "top-left",
    });
    expect(html).not.toContain("verified-tick");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/ai test creative-templates`
Expected: FAIL — `tweet_card` throws "not implemented".

- [ ] **Step 3: Implement `buildTweetCard` + wire dispatcher**

Add the builder:

```typescript
function buildTweetCard(opts: StaticCreativeOptions): string {
  const accent = opts.brandColor || "#1d9bf0";
  const tick = opts.verified
    ? `<svg class="verified-tick" width="26" height="26" viewBox="0 0 24 24" fill="${accent}"><path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.16-.032.322-.032.486 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.164-.012-.326-.032-.486 1.16-.688 1.943-1.99 1.943-3.486zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z"/></svg>`
    : "";
  const imgPair =
    opts.bgImageUrl && opts.secondaryImageUrl
      ? `<div class="pair"><img src="${opts.bgImageUrl}"/><img src="${opts.secondaryImageUrl}"/></div>`
      : opts.bgImageUrl
        ? `<div class="single"><img src="${opts.bgImageUrl}"/></div>`
        : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden;font-family:'Inter',system-ui,sans-serif;background:#fff;padding:64px 56px;display:flex;flex-direction:column;}
.head{display:flex;align-items:center;gap:18px;margin-bottom:28px;}
.name-row{display:flex;align-items:center;gap:8px;}
.name{font-size:34px;font-weight:800;color:#0f1419;}
.handle{font-size:26px;color:#536471;margin-top:2px;}
.text{font-size:40px;line-height:1.3;color:#0f1419;font-weight:400;margin-bottom:32px;}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:1;border-radius:18px;overflow:hidden;}
.pair img{width:100%;height:100%;object-fit:cover;}
.single{flex:1;border-radius:18px;overflow:hidden;}
.single img{width:100%;height:100%;object-fit:cover;}
</style></head><body>
<div class="head">
  ${logoHtml(opts, 72)}
  <div>
    <div class="name-row"><span class="name">${escapeHtml(opts.channelName)}</span>${tick}</div>
    ${opts.handle ? `<div class="handle">${escapeHtml(opts.handle)}</div>` : ""}
  </div>
</div>
<div class="text">${escapeHtml(opts.headline)}</div>
${imgPair}
</body></html>`;
}
```

Wire dispatcher:

```typescript
    case "tweet_card":
      return buildTweetCard(opts);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/ai test creative-templates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/tools/creative-templates.ts packages/ai/src/__tests__/creative-templates.test.ts
git commit -m "feat(ai): tweet_card creative style"
```

---

## Task 6: `bold_typographic` style

**Files:**
- Modify: `packages/ai/src/tools/creative-templates.ts`
- Test: `packages/ai/src/__tests__/creative-templates.test.ts`

- [ ] **Step 1: Add the failing test**

Append:

```typescript
describe("bold_typographic style", () => {
  it("renders large headline on brand background with corner logo", () => {
    const html = buildStaticCreative({
      style: "bold_typographic",
      headline: "This month's biggest releases.",
      channelName: "Moviefied",
      handle: "@moviefied",
      brandColor: "#e11d48",
      logoPosition: "top-left",
    });
    expect(html).toContain("This month's biggest releases.".replace(/'/g, "&#39;").length ? "biggest releases" : "biggest releases");
    expect(html).toContain("Moviefied");
    expect(html).toContain("#e11d48");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/ai test creative-templates`
Expected: FAIL — `bold_typographic` throws "not implemented".

- [ ] **Step 3: Implement `buildBoldTypographic` + wire dispatcher**

Add builder:

```typescript
function buildBoldTypographic(opts: StaticCreativeOptions): string {
  const accent = opts.brandColor || DEFAULT_ACCENT;
  const words = opts.headline.trim().split(/\s+/).length;
  const fs = words <= 4 ? 130 : words <= 7 ? 104 : words <= 11 ? 82 : 64;
  const corner = opts.logoPosition === "top-left" ? "left:56px;" : "right:56px;";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden;position:relative;font-family:'Inter',system-ui,sans-serif;background:#0d0d12;display:flex;align-items:center;padding:0 64px;}
.accent-band{position:absolute;top:0;left:0;width:14px;height:100%;background:${accent};}
.logo{position:absolute;top:56px;${corner}display:flex;align-items:center;gap:14px;}
.brand-tag{color:rgba(255,255,255,0.75);font-size:22px;font-weight:600;}
.headline{color:#fff;font-size:${fs}px;font-weight:900;line-height:1.02;letter-spacing:-0.03em;}
.rule{position:absolute;bottom:96px;left:64px;width:80px;height:5px;background:${accent};border-radius:3px;}
.name{position:absolute;bottom:48px;left:64px;color:rgba(255,255,255,0.7);font-size:24px;font-weight:600;}
</style></head><body>
<div class="accent-band"></div>
<div class="logo">${logoHtml(opts, 52)}${opts.handle ? `<span class="brand-tag">${escapeHtml(opts.handle)}</span>` : ""}</div>
<div class="headline">${escapeHtml(opts.headline)}</div>
<div class="rule"></div>
<div class="name">${escapeHtml(opts.channelName)}</div>
</body></html>`;
}
```

Wire dispatcher:

```typescript
    case "bold_typographic":
      return buildBoldTypographic(opts);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/ai test creative-templates`
Expected: PASS (all 4 styles now implemented).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/tools/creative-templates.ts packages/ai/src/__tests__/creative-templates.test.ts
git commit -m "feat(ai): bold_typographic creative style — all 4 styles complete"
```

---

## Task 7: Render styled creative via Puppeteer + export from package

**Files:**
- Modify: `packages/ai/src/tools/news-image-generator.ts`
- Modify: `packages/ai/src/index.ts`
- Test: covered by Task 3–6 (HTML unit tests). Puppeteer render is verified live in Task 17.

- [ ] **Step 1: Add a styled-render function to news-image-generator**

In `packages/ai/src/tools/news-image-generator.ts`, add at the top with the other imports:

```typescript
import { buildStaticCreative, type StaticCreativeOptions } from "./creative-templates";
```

Add this exported function (mirrors `generateStaticNewsCreativeImage`'s Puppeteer setup — `waitUntil:"load"`, 1080×1350, screenshot-on-timeout):

```typescript
/**
 * Render a styled social creative (4 selectable styles) to PNG. Same Puppeteer
 * config as generateStaticNewsCreativeImage: waitUntil "load" (inline data-URL
 * backgrounds never settle networkidle0), screenshot even if the wait times out.
 */
export async function generateStyledCreativeImage(
  options: StaticCreativeOptions
): Promise<NewsImageResult> {
  const html = buildStaticCreative(options);
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350 });
    try {
      await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    } catch (e) {
      console.warn(`[creative] setContent wait timed out, screenshotting anyway:`, (e as Error).message);
    }
    const screenshotBuffer = await page.screenshot({ type: "png", encoding: "base64" });
    return {
      imageBase64: screenshotBuffer as string,
      mimeType: "image/png",
      width: 1080,
      height: 1350,
      style: "news_card",
    };
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 2: Export from the package index**

In `packages/ai/src/index.ts`, add:

```typescript
export { generateStyledCreativeImage } from "./tools/news-image-generator";
export { buildStaticCreative } from "./tools/creative-templates";
export type { CreativeStyle, StaticCreativeOptions } from "./tools/creative-templates";
```

- [ ] **Step 3: Type-check the package**

Run: `pnpm --filter @postautomation/ai type-check`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add packages/ai/src/tools/news-image-generator.ts packages/ai/src/index.ts
git commit -m "feat(ai): generateStyledCreativeImage + export creative renderer"
```

---

## Task 8: Repurpose router — use styled renderer + style/logoPosition inputs (B2/B3/B4)

**Files:**
- Modify: `packages/api/src/routers/repurpose.router.ts`
- Test: live (Task 17). Type-check gates correctness here.

- [ ] **Step 1: Add `creativeStyle` + `logoPosition` to the input schema**

In `repurposeFromUrl`'s `z.object({...})` input (the block starting `format: z.enum([...])`), add after `logoUrl`:

```typescript
        creativeStyle: z
          .enum(["premium_editorial", "hook_bars", "tweet_card", "bold_typographic"])
          .default("premium_editorial"),
        logoPosition: z.enum(["top-left", "top-right"]).default("top-right"),
```

- [ ] **Step 2: Import the styled renderer**

In the dynamic `import("@postautomation/ai")` destructuring inside the mutation (where `generateStaticNewsCreativeImage` is imported), add `generateStyledCreativeImage`:

```typescript
        generateStaticNewsCreativeImage,
        generateStyledCreativeImage,
```

- [ ] **Step 3: Route `buildHeadlineCreative` through the styled renderer**

In `buildHeadlineCreative`, replace the `generateStaticNewsCreativeImage({...})` call with a style-aware call. Change:

```typescript
        const creative = await generateStaticNewsCreativeImage({
          headline,
          channelName: displayName,
          handle,
          logoUrl: resolvedLogoUrl || null,
          template,
          ...(backgroundImageUrl ? { backgroundImageUrl } : {}),
          ...(resolvedBrandColor ? { brandColor: resolvedBrandColor } : {}),
        });
        return { imageBase64: creative.imageBase64, mimeType: creative.mimeType, bgSource };
```

to:

```typescript
        const creative = await generateStyledCreativeImage({
          style: input.creativeStyle,
          headline,
          channelName: displayName,
          handle,
          logoUrl: resolvedLogoUrl || null,
          logoPosition: input.logoPosition,
          ...(backgroundImageUrl ? { bgImageUrl: backgroundImageUrl } : {}),
          ...(resolvedBrandColor ? { brandColor: resolvedBrandColor } : {}),
        });
        return { imageBase64: creative.imageBase64, mimeType: creative.mimeType, bgSource };
```

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @postautomation/api type-check`
Expected: PASS. (If `buildHeadlineCreative`'s return type is referenced elsewhere, it is unchanged.)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/repurpose.router.ts
git commit -m "feat(api): repurpose static + carousel cover use the 4-style creative renderer"
```

---

## Task 9: Carousel publish fix — create Media rows + ordered mediaIds (B1)

**Files:**
- Modify: `packages/api/src/routers/repurpose.router.ts`
- Test: live (Task 17); type-check here.

**Root cause (confirmed):** carousel slides upload to S3 but no `Media` rows are created and `perPlatformMedia` stays `{}`, so `post.create` gets zero `mediaIds`. We add `Media` rows per slide and return an ordered `carouselMediaIds` array, plus populate `perPlatformMedia` so existing UI paths also work.

- [ ] **Step 1: Add a `carouselMediaIds` accumulator near `perPlatformMedia`**

Find `const perPlatformMedia: Record<string, { url: string; mediaId: string }> = {};` and add right after it:

```typescript
      // Ordered slide media IDs for carousel posts (post.create needs real
      // Media rows, not raw S3 urls). Empty for non-carousel formats.
      const carouselMediaIds: string[] = [];
```

- [ ] **Step 2: Create a Media row per uploaded slide and record its id in order**

In the carousel upload loop, replace:

```typescript
        // Upload all successfully generated slides to S3
        for (let i = 0; i < slideImages.length; i++) {
          const slide = slideImages[i];
          if (!slide) continue;
          const ext = slide.mimeType.includes("png") ? "png" : "jpg";
          const contentType = slide.mimeType.includes("png") ? "image/png" : "image/jpeg";
          const key = `repurpose/carousel-${Date.now()}-${i}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
          const buf = Buffer.from(slide.imageBase64, "base64");
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }));
          uploadedUrls.push(getPublicUrl(key));
        }
```

with:

```typescript
        // Upload all successfully generated slides to S3 AND create a Media row
        // per slide so post.create can attach them (carousel publish fix).
        for (let i = 0; i < slideImages.length; i++) {
          const slide = slideImages[i];
          if (!slide) continue;
          const ext = slide.mimeType.includes("png") ? "png" : "jpg";
          const contentType = slide.mimeType.includes("png") ? "image/png" : "image/jpeg";
          const key = `repurpose/carousel-${Date.now()}-${i}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
          const buf = Buffer.from(slide.imageBase64, "base64");
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }));
          const slideUrl = getPublicUrl(key);
          uploadedUrls.push(slideUrl);
          const media = await ctx.prisma.media.create({
            data: {
              organizationId,
              uploadedById: userId,
              fileName: `carousel-${Date.now()}-${i}.${ext}`,
              fileType: contentType,
              fileSize: buf.length,
              url: slideUrl,
            },
          });
          carouselMediaIds.push(media.id);
        }
```

- [ ] **Step 3: Populate `perPlatformMedia` (first slide) for back-compat AND return `carouselMediaIds`**

After the upload loop's `progress(... "done" ...)` line, add (so existing `mediaMap` consumers still get a representative thumbnail):

```typescript
        if (carouselMediaIds.length > 0) {
          const first = { url: uploadedUrls[0]!, mediaId: carouselMediaIds[0]! };
          for (const platform of input.targetPlatforms) {
            perPlatformMedia[platform] = first;
          }
        }
```

Then in the final `return {...}` object, add `carouselMediaIds`:

```typescript
        platformContent,
        mediaUrls,
        mediaMap: perPlatformMedia,
        carouselMediaIds,
        mediaType,
        format: input.format,
        mediaFailed,
```

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @postautomation/api type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/repurpose.router.ts
git commit -m "fix(api): carousel slides create Media rows + return ordered carouselMediaIds (publish fix)"
```

---

## Task 10: Repurpose router — always-synthesize + truncate social headlines (B6.3/B6.4)

**Files:**
- Modify: `packages/api/src/routers/repurpose.router.ts`
- Test: live (Task 17); type-check here.

- [ ] **Step 1: Add a headline-truncation helper near the top of the mutation body**

Immediately after `const handle = channelHandle || displayName;` (in the "4. Generate media based on format" area), add:

```typescript
      // Cap headlines so the template's word-count font sizing stays readable
      // (≥16 words renders at 40px). Applies to all formats.
      function capHeadline(text: string): string {
        const words = text.trim().split(/\s+/);
        let out = words.slice(0, 12).join(" ");
        if (out.length > 80) out = out.slice(0, 80).replace(/\s+\S*$/, "");
        return out.trim();
      }
```

- [ ] **Step 2: Always synthesize a clean headline for social-type extracts**

In the `if (input.format === "static")` branch, the current code computes `headlineForCreative` from `looksGenericTitle`/`briefSubject`. Right **before** the `const bgPrompt = ...` line, insert a social-aware override:

```typescript
        let headlineForCreativeFinal = headlineForCreative;
        if (extracted.type === "social") {
          // Social captions are not article titles — synthesize a concise headline
          // from the caption/body rather than dumping the raw caption (which may be
          // a long emoji-laden sentence) into the headline slot.
          try {
            const synth = await generateContentResilient({
              provider: input.provider,
              platform: "INSTAGRAM",
              userPrompt: `Write ONE concise, punchy news-style headline (max 10 words, no hashtags, no emojis) summarizing this social post. Return ONLY the headline text.\n\nPost: ${(extracted.body || extracted.description || extracted.title).slice(0, 800)}`,
              tone: "professional",
            });
            const cleaned = synth.replace(/^["']|["']$/g, "").replace(/\n[\s\S]*$/, "").trim();
            if (cleaned.length > 3) headlineForCreativeFinal = cleaned;
          } catch (e) {
            console.warn(`[Repurpose] Social headline synthesis failed, using extracted title:`, (e as Error).message);
          }
        }
        headlineForCreativeFinal = capHeadline(headlineForCreativeFinal);
```

Then change the `bgPrompt` template and the `buildHeadlineCreative` call to use `headlineForCreativeFinal` instead of `headlineForCreative`:
- In the `bgPrompt` string: `Topic: "${headlineForCreativeFinal}"`.
- In the `buildHeadlineCreative(bgPrompt, headlineForCreative, category)` call: pass `headlineForCreativeFinal`.

> Note: `generateContentResilient` is already defined/imported in this mutation (used by carousel/video branches). If its signature differs, match the existing call sites in the same file (search `generateContentResilient(`).

- [ ] **Step 3: Apply `capHeadline` to the carousel cover headline too**

In the carousel branch, the cover slide is built from `extracted.title`. Find where `allSlides` is built:

```typescript
        const allSlides = [
          { type: "cover", title: extracted.title, body: extracted.description?.slice(0, 100) || "" },
```

change the cover title to a capped (and, for social, the same synthesized) headline. Replace with:

```typescript
        const coverHeadline = capHeadline(extracted.title);
        const allSlides = [
          { type: "cover", title: coverHeadline, body: extracted.description?.slice(0, 100) || "" },
```

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @postautomation/api type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/repurpose.router.ts
git commit -m "fix(api): synthesize + cap social headlines so captions never become raw headlines"
```

---

## Task 11: CreativeTemplate Prisma model + back-relations (B4 templates)

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Test: `pnpm db:push` validation + a generate.

- [ ] **Step 1: Add the model + back-relations**

In `packages/db/prisma/schema.prisma`, add the model (place it near `DesignTemplate` at ~line 877):

```prisma
model CreativeTemplate {
  id             String       @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name           String
  style          String // "premium_editorial" | "hook_bars" | "tweet_card" | "bold_typographic"
  logoMediaId    String?
  logoMedia      Media?       @relation(fields: [logoMediaId], references: [id], onDelete: SetNull)
  logoPosition   String       @default("top-right")
  brandColor     String?
  channelId      String?
  createdById    String
  createdBy      User         @relation(fields: [createdById], references: [id])
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@index([organizationId])
}
```

Add the back-relation field to each related model:
- In `model Organization {` (line 109): add `creativeTemplates CreativeTemplate[]`
- In `model Media {` (line 334), in its relations block (after `chatAttachments ChatAttachment[]`): add `creativeTemplates CreativeTemplate[]`
- In `model User {` (line 12): add `creativeTemplates CreativeTemplate[]`

- [ ] **Step 2: Validate + push the schema**

Run: `pnpm --filter @postautomation/db exec prisma validate`
Expected: "The schema is valid 🚀"

Run: `pnpm db:push`
Expected: applies the new `CreativeTemplate` table additively (no destructive changes proposed). If it proposes dropping anything, STOP — a name collision exists; do not proceed.

- [ ] **Step 3: Regenerate the client**

Run: `pnpm --filter @postautomation/db exec prisma generate`
Expected: client regenerated with `prisma.creativeTemplate`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "feat(db): CreativeTemplate model + back-relations on Organization/Media/User"
```

---

## Task 12: creative-template tRPC router (org-scoped CRUD + IDOR guard)

**Files:**
- Create: `packages/api/src/routers/creative-template.router.ts`
- Modify: `packages/api/src/root.ts`
- Test: `packages/api/src/__tests__/creative-template-ownership.test.ts` (create)

- [ ] **Step 1: Write the failing ownership test**

Create `packages/api/src/__tests__/creative-template-ownership.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { assertLogoMediaOwned } from "../routers/creative-template.router";

function mockPrisma(found: Array<{ id: string }>) {
  return {
    media: { findFirst: vi.fn(async () => found[0] ?? null) },
  } as any;
}

describe("assertLogoMediaOwned", () => {
  it("passes when logoMediaId is undefined (no-reference path)", async () => {
    await expect(assertLogoMediaOwned(mockPrisma([]), "org-1", undefined)).resolves.toBeUndefined();
  });
  it("passes when the logo media belongs to the org", async () => {
    await expect(assertLogoMediaOwned(mockPrisma([{ id: "m1" }]), "org-1", "m1")).resolves.toBeUndefined();
  });
  it("throws FORBIDDEN when the logo media is not in the org", async () => {
    await expect(assertLogoMediaOwned(mockPrisma([]), "org-1", "m-other")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/api test creative-template-ownership`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the router**

Create `packages/api/src/routers/creative-template.router.ts`:

```typescript
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";

/** Validate an optional logo media id belongs to the org (IDOR guard). */
export async function assertLogoMediaOwned(
  prisma: any,
  organizationId: string,
  logoMediaId: string | undefined
): Promise<void> {
  if (!logoMediaId) return;
  const found = await prisma.media.findFirst({
    where: { id: logoMediaId, organizationId },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Logo media not found in this organization." });
  }
}

const STYLE = z.enum(["premium_editorial", "hook_bars", "tweet_card", "bold_typographic"]);
const POSITION = z.enum(["top-left", "top-right"]);

export const creativeTemplateRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.creativeTemplate.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      include: { logoMedia: { select: { url: true } } },
    });
  }),

  create: orgProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        style: STYLE,
        logoMediaId: z.string().optional(),
        logoPosition: POSITION.default("top-right"),
        brandColor: z.string().optional(),
        channelId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertLogoMediaOwned(ctx.prisma, ctx.organizationId, input.logoMediaId);
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
        },
      });
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(80).optional(),
        style: STYLE.optional(),
        logoMediaId: z.string().nullable().optional(),
        logoPosition: POSITION.optional(),
        brandColor: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.creativeTemplate.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.logoMediaId) {
        await assertLogoMediaOwned(ctx.prisma, ctx.organizationId, input.logoMediaId);
      }
      return ctx.prisma.creativeTemplate.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.style !== undefined && { style: input.style }),
          ...(input.logoMediaId !== undefined && { logoMediaId: input.logoMediaId }),
          ...(input.logoPosition !== undefined && { logoPosition: input.logoPosition }),
          ...(input.brandColor !== undefined && { brandColor: input.brandColor }),
        },
      });
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.creativeTemplate.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.creativeTemplate.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
```

- [ ] **Step 4: Mount the router**

In `packages/api/src/root.ts`, add the import after the `designTemplateRouter` import (line 29):

```typescript
import { creativeTemplateRouter } from "./routers/creative-template.router";
```

and add to the `createRouter({...})` object (near `designTemplate: designTemplateRouter`):

```typescript
  creativeTemplate: creativeTemplateRouter,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @postautomation/api test creative-template-ownership`
Expected: PASS (3 tests).

- [ ] **Step 6: Type-check + commit**

Run: `pnpm --filter @postautomation/api type-check`
Expected: PASS.

```bash
git add packages/api/src/routers/creative-template.router.ts packages/api/src/root.ts packages/api/src/__tests__/creative-template-ownership.test.ts
git commit -m "feat(api): creative-template router (org-scoped CRUD + logo IDOR guard)"
```

---

## Task 13: RepurposeTab UI — style picker, brand-ref panel, template dropdown, carousel mediaIds, video relabel (B2/B4/B5/B1-UI)

**Files:**
- Modify: `apps/web/components/content-agent/RepurposeTab.tsx`
- Test: live (Task 17); type-check + lint here.

- [ ] **Step 1: Relabel formats + disable Veo3 (B5)**

Replace the `FORMAT_OPTIONS` array with:

```typescript
const FORMAT_OPTIONS = [
  { id: "static" as const, label: "Static Post", icon: Image, desc: "Single branded image + caption" },
  { id: "carousel" as const, label: "Carousel", icon: Layers, desc: "Multi-slide carousel post" },
  { id: "reel" as const, label: "Slideshow Reel", icon: Film, desc: "Your key points become video slides with optional voiceover + music" },
  { id: "seedance_video" as const, label: "AI Video", icon: Video, desc: "Real AI-generated cinematic footage with native audio", badge: "NEW" },
  { id: "ai_video" as const, label: "AI Video (Veo3)", icon: Video, desc: "Temporarily unavailable", disabled: true, badge: "SOON" },
];
```

In the format-picker render (the `.map` over `FORMAT_OPTIONS`), make the button respect `disabled`. Find the format `<button>` and add to its props:

```tsx
                    disabled={(f as any).disabled}
                    title={(f as any).disabled ? "Temporarily unavailable (billing)" : undefined}
                    className={`... ${(f as any).disabled ? "opacity-40 cursor-not-allowed" : ""}`}
```

(Keep the existing className content; append the disabled modifier. The exact existing className is preserved — only the disabled clause is appended.)

- [ ] **Step 2: Add new state: creativeStyle, logoPosition, brand ref, selected template**

In the "// Options" state block, after `const [bgMusic, setBgMusic] = useState(true);`, add:

```typescript
  const [creativeStyle, setCreativeStyle] = useState<"premium_editorial" | "hook_bars" | "tweet_card" | "bold_typographic">("premium_editorial");
  const [logoPosition, setLogoPosition] = useState<"top-left" | "top-right">("top-right");
  const [logoUrl, setLogoUrl] = useState<string>("");
  const [logoMediaId, setLogoMediaId] = useState<string>("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
```

- [ ] **Step 3: Load templates + add the brand-reference panel UI**

Near the other tRPC hooks at the top of the component, add:

```typescript
  const { data: creativeTemplates } = trpc.creativeTemplate.list.useQuery();
  const createTemplate = trpc.creativeTemplate.create.useMutation();
  const utils = trpc.useUtils();
```

Add this panel JSX inside the options card, right after the format picker block (before the Theme block):

```tsx
              {/* Creative style (static + carousel cover) */}
              {(format === "static" || format === "carousel") && (
                <div className="space-y-2">
                  <Label>Creative Style</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: "premium_editorial", label: "Premium Editorial" },
                      { id: "hook_bars", label: "Hook + Headline" },
                      { id: "tweet_card", label: "Tweet / Post Card" },
                      { id: "bold_typographic", label: "Bold Typographic" },
                    ].map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setCreativeStyle(s.id as typeof creativeStyle)}
                        className={`rounded-lg border px-3 py-2 text-xs font-medium ${creativeStyle === s.id ? "border-primary bg-primary/10" : "border-border"}`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  {/* Brand reference */}
                  <Label className="pt-2 block">Brand Reference (optional)</Label>
                  {creativeTemplates && creativeTemplates.length > 0 && (
                    <Select
                      value={selectedTemplateId}
                      onValueChange={(id) => {
                        setSelectedTemplateId(id);
                        const t = creativeTemplates.find((x) => x.id === id);
                        if (t) {
                          setCreativeStyle(t.style as typeof creativeStyle);
                          setLogoPosition((t.logoPosition as "top-left" | "top-right") ?? "top-right");
                          setLogoUrl(t.logoMedia?.url ?? "");
                          setLogoMediaId(t.logoMediaId ?? "");
                        }
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Use a saved brand template…" /></SelectTrigger>
                      <SelectContent>
                        {creativeTemplates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      accept="image/*"
                      id="logo-upload"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        const fd = new FormData();
                        fd.append("file", file);
                        fd.append("category", "logo");
                        const res = await fetch("/api/upload", { method: "POST", body: fd });
                        if (res.ok) {
                          const { id, url } = await res.json();
                          setLogoUrl(url); setLogoMediaId(id);
                        } else {
                          toast({ title: "Logo upload failed", variant: "destructive" });
                        }
                      }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById("logo-upload")?.click()}>
                      {logoUrl ? "Change logo" : "Upload logo"}
                    </Button>
                    {logoUrl && <img src={logoUrl} alt="logo" className="h-8 w-8 rounded object-contain border" />}
                    <Select value={logoPosition} onValueChange={(v) => setLogoPosition(v as "top-left" | "top-right")}>
                      <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="top-right">Logo top-right</SelectItem>
                        <SelectItem value="top-left">Logo top-left</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {logoUrl && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        const name = window.prompt("Name this brand template:");
                        if (!name) return;
                        await createTemplate.mutateAsync({
                          name,
                          style: creativeStyle,
                          logoMediaId: logoMediaId || undefined,
                          logoPosition,
                        });
                        utils.creativeTemplate.list.invalidate();
                        toast({ title: "Brand template saved" });
                      }}
                    >
                      Save as template
                    </Button>
                  )}
                </div>
              )}
```

- [ ] **Step 4: Pass new fields to the generate mutation + result type + carousel mediaIds**

(a) Add `carouselMediaIds?: string[]` to the `results` state type (the `useState<{...}>` object), after `mediaMap?:`:

```typescript
    carouselMediaIds?: string[];
```

(b) In `handleGenerate` where `repurposeFromUrl.mutate(...)` / `.mutateAsync(...)` is called with the input object, add:

```typescript
        creativeStyle,
        logoPosition,
        logoUrl: logoUrl || undefined,
```

(c) In the "Create Drafts" button onClick, change the mediaId collection to prefer `carouselMediaIds`:

```typescript
                    const mediaIds: string[] = [];
                    if (results.carouselMediaIds && results.carouselMediaIds.length > 0) {
                      mediaIds.push(...results.carouselMediaIds);
                    } else if (results.mediaMap) {
                      const seen = new Set<string>();
                      for (const m of Object.values(results.mediaMap)) {
                        if (m.mediaId && !seen.has(m.mediaId)) {
                          mediaIds.push(m.mediaId);
                          seen.add(m.mediaId);
                        }
                      }
                    }
```

- [ ] **Step 5: Type-check + lint**

Run: `pnpm --filter @postautomation/web type-check`
Expected: PASS. (If `trpc.useUtils` is named `trpc.useContext` in this codebase, use that — check an existing component.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/content-agent/RepurposeTab.tsx
git commit -m "feat(web): repurpose style picker, brand-ref + templates, carousel mediaIds, video relabel"
```

---

# MODULE A — Super Agent

## Task 14: Vision-only provider fallback + real hasAttachments (A1b)

**Files:**
- Modify: `apps/web/app/api/chat/stream/route.ts`
- Test: live (Task 17); reasoned inline.

- [ ] **Step 1: Detect attachments from loaded messages**

In `apps/web/app/api/chat/stream/route.ts`, the history query currently selects `{ role, content, metadata }`. Change it to also load attachment media:

```typescript
  const dbMessages = await prisma.chatMessage.findMany({
    where: { threadId: body.threadId },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: {
      role: true,
      content: true,
      metadata: true,
      attachments: {
        select: { media: { select: { url: true, fileType: true } } },
      },
    },
  });
```

After `const lastUserMessage = ...` block, compute attachment presence on the most recent user message:

```typescript
  const lastUserDbMsg = [...dbMessages].reverse().find((m) => m.role === "user");
  const lastUserImages = (lastUserDbMsg?.attachments ?? [])
    .map((a) => a.media)
    .filter((m) => m && m.fileType?.startsWith("image"))
    .map((m) => m!.url);
  const hasImageAttachments = lastUserImages.length > 0;
```

- [ ] **Step 2: Pass real `hasAttachments` + restrict fallback to vision providers**

Change the `routeProvider(...)` call's `hasAttachments: false` to:

```typescript
        hasAttachments: hasImageAttachments,
```

Change the `FALLBACK_PRIORITY` line so it is vision-only when attachments are present:

```typescript
  // Vision-capable only when images are attached (grok/deepseek/gemma4 have no vision API).
  const FALLBACK_PRIORITY: AIProvider[] = hasImageAttachments
    ? ["gemini", "openai", "anthropic"]
    : ["openai", "anthropic", "grok", "deepseek", "gemini", "gemma4"];
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @postautomation/web type-check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/chat/stream/route.ts
git commit -m "fix(web): real hasAttachments + vision-only provider fallback in chat stream"
```

---

## Task 15: Multimodal message plumbing — widen ChatMessage + LangChain image parts + Gemini inlineData (A1a)

**Files:**
- Modify: `packages/ai/src/chains/chat-agent.chain.ts`
- Modify: `packages/ai/src/providers/gemini.provider.ts`
- Modify: `apps/web/app/api/chat/stream/route.ts`
- Test: live (Task 17); type-check here.

- [ ] **Step 1: Widen `ChatMessage` to allow multimodal content**

In `packages/ai/src/chains/chat-agent.chain.ts`, change the `ChatMessage` interface:

```typescript
export type ChatMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ChatMessageContentPart[];
}
```

- [ ] **Step 2: Pass array content through to LangChain HumanMessage**

In `streamChatAgent`, the LangChain branch maps messages. Change the user mapping to pass array content unchanged (LangChain `HumanMessage` accepts `string | MessageContentComplex[]`):

```typescript
      ...messages.map((m) => {
        if (m.role === "user") return new HumanMessage({ content: m.content as any });
        return new AIMessage(typeof m.content === "string" ? m.content : "");
      }),
```

- [ ] **Step 3: Build Gemini Parts (incl. inlineData) for the Gemini branch**

First, refactor `callGemini` in `packages/ai/src/providers/gemini.provider.ts` to accept either a string or Gemini `Content[]`:

```typescript
import { GoogleGenerativeAI, type Content } from "@google/generative-ai";
```

Change the signature + body:

```typescript
export async function callGemini(
  promptOrContents: string | Content[],
  options: { temperature?: number; maxTokens?: number; grounded?: boolean } = {}
): Promise<string> {
  const client = getClient();

  const tools: Tool[] = [];
  if (options.grounded) {
    tools.push({ googleSearch: {} } as Tool);
  }

  const model = client.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 4096,
    },
    ...(tools.length > 0 ? { tools } : {}),
  });

  const result = await model.generateContent(promptOrContents as any);
  const response = result.response;
  return response.text();
}
```

(`generateContent` accepts `string | GenerateContentRequest | (string|Part)[]`; passing `Content[]` for a single-turn request works because the SDK wraps it. If type-check complains, pass `{ contents: promptOrContents }` when it is an array — see Step 5 fallback.)

In `chat-agent.chain.ts`, the Gemini branch currently builds plain text. Replace the Gemini branch body so the last user message's image parts become `inlineData`. Add this helper above `streamChatAgent`:

```typescript
async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString("base64"), mimeType };
  } catch {
    return null;
  }
}
```

Then in the Gemini `else` branch, before calling `callGemini`, build a `Content[]`:

```typescript
  } else {
    // Gemini branch — supports multimodal via inlineData parts.
    const { GoogleGenerativeAI } = await import("@google/generative-ai"); // type side-effect only
    const contents: any[] = [{ role: "user", parts: [{ text: systemPrompt }] }];
    for (const m of messages) {
      const role = m.role === "assistant" ? "model" : "user";
      if (typeof m.content === "string") {
        contents.push({ role, parts: [{ text: m.content }] });
      } else {
        const parts: any[] = [];
        for (const part of m.content) {
          if (part.type === "text") parts.push({ text: part.text });
          else if (part.type === "image_url") {
            const img = await fetchImageAsBase64(part.image_url.url);
            if (img) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
          }
        }
        contents.push({ role, parts });
      }
    }
    const text = await callGemini(contents as any, { temperature: 0.7 });
    yield text;
    return;
  }
```

> Remove/replace the old text-only `formattedMessages` Gemini code that this `else` branch replaces. Keep the gemma4 path if it exists separately (search `callGemma4`); this change is only for the native Gemini provider branch.

- [ ] **Step 4: Build multimodal messages in the stream route**

In `apps/web/app/api/chat/stream/route.ts`, where `messages` is built from `dbMessages`, change so the **last user message** with images becomes multimodal:

```typescript
  const messages: AIChatMessage[] = dbMessages.map((m) => {
    const imgs = (m.attachments ?? [])
      .map((a) => a.media)
      .filter((md) => md && md.fileType?.startsWith("image"))
      .map((md) => md!.url);
    if (m.role === "user" && imgs.length > 0) {
      return {
        role: "user" as const,
        content: [
          { type: "text" as const, text: m.content || "(see attached image)" },
          ...imgs.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ],
      };
    }
    return { role: m.role as "user" | "assistant" | "system", content: m.content };
  });
```

Note: `detectTrendingIntent(lastUserMessage.content)` expects a string. Guard it:

```typescript
    const lastText = typeof lastUserMessage.content === "string"
      ? lastUserMessage.content
      : lastUserMessage.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
    const trendingIntent = detectTrendingIntent(lastText);
```

And `routeProvider(lastUserMessage?.content ?? "", ...)` — pass `lastText` instead.

- [ ] **Step 5: Type-check (both packages)**

Run: `pnpm --filter @postautomation/ai type-check && pnpm --filter @postautomation/web type-check`
Expected: PASS. If `callGemini(contents)` fails type-check, change the array call inside `callGemini` to `model.generateContent({ contents: promptOrContents as Content[] })` in the array case (branch on `Array.isArray`).

- [ ] **Step 6: Commit**

```bash
git add packages/ai/src/chains/chat-agent.chain.ts packages/ai/src/providers/gemini.provider.ts apps/web/app/api/chat/stream/route.ts
git commit -m "feat(ai): multimodal chat — widen ChatMessage, LangChain image parts, Gemini inlineData"
```

---

## Task 16: Chat action media plumbing + prompt awareness (A2/A3)

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts`
- Modify: `apps/web/app/dashboard/super-agent/page.tsx`
- Modify: `packages/ai/src/prompts/chat-agent.prompt.ts`
- Test: `packages/api/src/__tests__/chat-action-media.test.ts` (create — guards mediaIds ownership)

- [ ] **Step 1: Write the failing ownership test for action mediaIds**

Create `packages/api/src/__tests__/chat-action-media.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { assertMediaOwned } from "../routers/chat.router";

function mockPrisma(found: Array<{ id: string }>) {
  return { media: { findMany: vi.fn(async () => found) } } as any;
}

describe("assertMediaOwned", () => {
  it("passes for empty mediaIds", async () => {
    await expect(assertMediaOwned(mockPrisma([]), "org-1", [])).resolves.toBeUndefined();
  });
  it("passes when all media belong to the org", async () => {
    await expect(assertMediaOwned(mockPrisma([{ id: "m1" }, { id: "m2" }]), "org-1", ["m1", "m2"])).resolves.toBeUndefined();
  });
  it("throws FORBIDDEN when a media id is foreign", async () => {
    await expect(assertMediaOwned(mockPrisma([{ id: "m1" }]), "org-1", ["m1", "m-other"])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/api test chat-action-media`
Expected: FAIL — `assertMediaOwned` not exported.

- [ ] **Step 3: Add `assertMediaOwned` + attach media in publish_now/schedule_post/bulk**

In `packages/api/src/routers/chat.router.ts`, near `assertChannelsOwned`, add and export:

```typescript
export async function assertMediaOwned(
  prisma: any,
  organizationId: string,
  mediaIds: string[]
): Promise<void> {
  if (!mediaIds || mediaIds.length === 0) return;
  const owned = await prisma.media.findMany({
    where: { id: { in: mediaIds }, organizationId },
    select: { id: true },
  });
  if (owned.length !== new Set(mediaIds).size) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Some media are not in this organization." });
  }
}
```

In the `publish_now` case, after `await assertChannelsOwned(...)`, add:

```typescript
          const mediaIds: string[] = Array.isArray(p.mediaIds) ? p.mediaIds : [];
          await assertMediaOwned(ctx.prisma, ctx.organizationId, mediaIds);
```

and add the media attachment to that `post.create` `data` object (after the `targets: {...}` block):

```typescript
              ...(mediaIds.length && {
                mediaAttachments: {
                  create: mediaIds.map((mediaId: string, index: number) => ({ mediaId, order: index })),
                },
              }),
```

Do the same in the `schedule_post` case (and `bulk_schedule` per-item, using `item.mediaIds`). For `schedule_post`:

```typescript
          const mediaIds: string[] = Array.isArray(p.mediaIds) ? p.mediaIds : [];
          await assertMediaOwned(ctx.prisma, ctx.organizationId, mediaIds);
```

then add the same `...(mediaIds.length && { mediaAttachments: {...} })` to its `post.create` data.

- [ ] **Step 4: Client merges attachment mediaIds into the executed action**

In `apps/web/app/dashboard/super-agent/page.tsx`, in `executeAction` (the `useCallback` that calls `executeActionMutation.mutateAsync`), merge attachment mediaIds for post actions. Change the body to:

```typescript
    async (action: { type: string; payload: Record<string, unknown> }) => {
      if (!activeThreadId) return;
      const postActions = ["publish_now", "schedule_post", "bulk_schedule"];
      let payload = action.payload;
      if (postActions.includes(action.type) && attachments.length > 0 && !("mediaIds" in payload)) {
        payload = { ...payload, mediaIds: attachments.map((a) => a.mediaId) };
      }
      try {
        await executeActionMutation.mutateAsync({
          threadId: activeThreadId,
          actionType: action.type as any,
          payload,
        });
        utils.chat.getThread.invalidate({ id: activeThreadId });
        utils.chat.listThreads.invalidate();
        utils.agent.list.invalidate();
      } catch (error: any) {
        setMessages((prev) => [
          ...prev,
          { id: `err-${Date.now()}`, role: "system", content: `Action failed: ${error.message}` },
        ]);
      }
    },
    [activeThreadId, executeActionMutation, utils, attachments]
```

- [ ] **Step 5: Add the ATTACHED MEDIA prompt section**

In `packages/ai/src/prompts/chat-agent.prompt.ts`, append to `CHAT_AGENT_SYSTEM_PROMPT` (before the closing backtick, after BEHAVIORAL RULES):

```
## ATTACHED MEDIA
When the user attaches an image, you CAN see it — describe it accurately when asked. Never claim you cannot see images.
When the user says "post this", "publish this", or "schedule this" while an image is attached, emit the post action normally; the image is attached automatically to the created post. Do not ask the user to re-provide the image.
```

- [ ] **Step 6: Run test + type-check**

Run: `pnpm --filter @postautomation/api test chat-action-media`
Expected: PASS (3 tests).

Run: `pnpm --filter @postautomation/api test chat-action-gating chat-channel-ownership && pnpm --filter @postautomation/web type-check`
Expected: existing gating/ownership tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routers/chat.router.ts apps/web/app/dashboard/super-agent/page.tsx packages/ai/src/prompts/chat-agent.prompt.ts packages/api/src/__tests__/chat-action-media.test.ts
git commit -m "feat: chat actions carry attachment media + prompt knows about attachments"
```

---

## Task 17: Full test suite + live end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suites**

Run: `pnpm --filter @postautomation/ai test && pnpm --filter @postautomation/api test`
Expected: ALL green (new tests + existing `chat-action-gating`, `chat-channel-ownership`, `s3-config`).

- [ ] **Step 2: Type-check the monorepo**

Run: `pnpm type-check`
Expected: PASS across web/api/ai/db.

- [ ] **Step 3: Start the app (per CLAUDE.md / `run` skill)**

Ensure infra is up (`docker compose up -d`), then `pnpm dev`. (If the page is blank / routes 404, kill stray turbo-dev servers first per memory `project-postautomation-dev-emfile`.)

- [ ] **Step 4: Verify each acceptance scenario** (record pass/fail with notes)

1. **Super Agent vision:** Upload an image → "what is this image?" → agent describes the actual image (not "please describe").
2. **Super Agent post-with-image:** Upload an image → "post this to <channel>" → a `publish_now` action renders with the image; confirm → created post has the image attached (check Posts).
3. **Static, 4 styles:** Repurpose a public news URL as Static with each `creativeStyle` → each renders, polished, logo placed per position; brand color from the uploaded logo reflected.
4. **No-reference static:** Repurpose Static with NO logo → still renders cleanly (logo-less, default accent), no error.
5. **Carousel publish:** Repurpose a URL as Carousel → cover uses the chosen style → "Create Drafts" → draft post has ALL slides attached (no empty-media failure).
6. **Brand template round-trip:** Upload logo → "Save as template" → reload → template appears in dropdown → selecting it pre-fills style+logo+position.
7. **Social URL — Instagram:** Paste an Instagram post link → headline is clean (no `&quot;`/emoji-entity garbage), sensible; og:image used as background.
8. **Social URL — Facebook:** Same for a public Facebook post link.
9. **Video menu:** Veo3 shows disabled "Temporarily unavailable"; Slideshow Reel + AI Video labels present.

- [ ] **Step 5: Commit any fixes found during verification**

If a scenario fails, fix it (smallest change), re-run the relevant test/scenario, and commit:

```bash
git add -A
git commit -m "fix: <specific issue found during live verification>"
```

- [ ] **Step 6: Final verification summary**

Write a short PASS/FAIL summary of all 9 scenarios into the PR description (or report to the user).

---

## Self-Review (completed by plan author)

**Spec coverage:** A1 (vision) → Tasks 14,15; A2 (action media) → Task 16; A3 (prompt) → Task 16; B2/B3 (4-style renderer + cover) → Tasks 3–8; B4 (brand ref + templates + no-ref) → Tasks 8,11,12,13; B5 (video menu) → Task 13; B6 (entity decode + synth + truncate) → Tasks 1,2,10; B1 (carousel publish) → Task 9. ✅ All spec items mapped.

**Placeholder scan:** No TBD/TODO; every code step has complete code. The two "if type-check complains" notes (Gemini `generateContent` array shape, `useUtils` vs `useContext`) are concrete fallbacks with the exact alternative given, not vague placeholders. ✅

**Type consistency:** `StaticCreativeOptions`/`CreativeStyle` consistent across Tasks 3–8 and the router (Task 8) and templates (Tasks 11–13). `creativeStyle`/`logoPosition` input names consistent between router (Task 8) and UI (Task 13). `carouselMediaIds` consistent between router return (Task 9) and UI consumption (Task 13). `assertMediaOwned`/`assertLogoMediaOwned` consistent between routers (Tasks 12,16) and tests. ✅

**Risk notes for the executor:**
- Task 15 (Gemini multimodal) is the highest-risk: the `@google/generative-ai` `generateContent` overload may need `{ contents }` wrapping — the fallback is stated inline.
- Task 11 `db:push`: if it proposes ANY destructive change, STOP (name collision) — do not force.
- Live verification (Task 17) is where the two image providers' real behavior (Gemini billing hold) shows: brand-conditioned AI backgrounds may be absent during the hold, but the deterministic template logo/color must still render — that is the designed behavior, not a failure.
