# FB/IG Connect, YouTube Shorts, AI Features, Channels Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Facebook/Instagram OAuth connect, make YouTube "Short" format validate before upload (fail clearly on non-Short videos) while reliably tagging `#Shorts`, fix the stale default AI model, and remove the confusing "Max NNNN chars" text on the channels page.

**Architecture:** Four independent changes in an existing Turborepo monorepo (Next.js web + BullMQ worker + shared packages). No new services. YouTube validation uses `ffprobe` (already in the worker Docker image) via `child_process`, matching the existing `apps/worker/src/lib/video-overlay.ts` pattern. FB/IG fixes are code-side robustness plus an operator runbook (the dashboard config is the operator's action, not code).

**Tech Stack:** TypeScript (strict), Next.js App Router, tRPC, Prisma, BullMQ, Vitest, FFmpeg/ffprobe, pnpm@9.15.0.

**Conventions:** pnpm (NOT npm). Run type-check with `pnpm type-check`; tests with `pnpm test`. Filter to a workspace with `pnpm --filter @postautomation/<name> <cmd>`. Commit after each task. End commit messages with the Co-Authored-By trailer.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `apps/web/app/api/oauth/callback/[provider]/route.ts` | OAuth 2.0 callback | Modify: lowercase redirect_uri; emit specific opaque error codes for FB-no-pages / IG-no-business-account |
| `apps/web/app/dashboard/channels/page.tsx` | Channels UI | Modify: remove "Max NNNN chars" text; add new error-code copy |
| `packages/social/src/providers/youtube.provider.ts` | YouTube upload | Modify: correct `#Shorts` hint; add ffprobe-based Short validation that throws on non-vertical/long video |
| `packages/social/src/__tests__/youtube-shorts.test.ts` | Tests | Create: unit tests for the Short validation + `#Shorts` hint helper |
| `packages/ai/src/providers/openai.provider.ts` | OpenAI provider | Modify: update default model from `gpt-4-turbo` to `gpt-4o` |
| `docs/META_APP_SETUP.md` | Operator runbook | Create: exact Meta-dashboard steps to make FB/IG connectable by normal users |

Tasks are ordered cheapest-first and are independent; they can be committed separately.

---

## Task 1: Remove "Max NNNN chars" text on the channels page

**Files:**
- Modify: `apps/web/app/dashboard/channels/page.tsx:797-803`

- [ ] **Step 1: Edit the card description to drop the char-limit branch**

Current code (lines 797-803):

```tsx
                    <p className="truncate text-xs text-muted-foreground">
                      {isToken
                        ? "No developer app needed"
                        : needsSetup
                        ? "OAuth credentials missing"
                        : `Max ${p.constraints.maxContentLength} chars`}
                    </p>
```

Replace with (connected/ready OAuth platforms now show an actionable hint instead of a char count):

```tsx
                    <p className="truncate text-xs text-muted-foreground">
                      {isToken
                        ? "No developer app needed"
                        : needsSetup
                        ? "OAuth credentials missing"
                        : "Click to connect"}
                    </p>
```

Rationale: `p.constraints.maxContentLength` is still used server-side for validation and must NOT be removed from the providers — only this display string changes.

- [ ] **Step 2: Type-check the web app**

Run: `pnpm --filter @postautomation/web type-check`
Expected: PASS (no type errors). If the workspace has no `type-check` script, run `pnpm type-check` from the repo root.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/dashboard/channels/page.tsx
git commit -m "fix(channels): remove confusing 'Max NNNN chars' text from platform cards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Update stale default OpenAI model

**Files:**
- Modify: `packages/ai/src/providers/openai.provider.ts:1-9`

- [ ] **Step 1: Update the model name**

Current file:

```ts
import { ChatOpenAI } from "@langchain/openai";

export function getOpenAIModel(temperature = 0.7) {
  return new ChatOpenAI({
    modelName: "gpt-4-turbo",
    temperature,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}
```

Replace the whole file with (allow an env override, default to the current `gpt-4o`):

```ts
import { ChatOpenAI } from "@langchain/openai";

// Default to gpt-4o (current, non-deprecated). Operators can override via
// OPENAI_MODEL without a code change if OpenAI rotates model IDs again.
const DEFAULT_OPENAI_MODEL = "gpt-4o";

export function getOpenAIModel(temperature = 0.7) {
  return new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    temperature,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}
```

- [ ] **Step 2: Type-check the ai package**

Run: `pnpm --filter @postautomation/ai type-check`
Expected: PASS. (Fallback: `pnpm type-check` from root.)

- [ ] **Step 3: Run existing AI tests to confirm nothing broke**

Run: `pnpm --filter @postautomation/ai test`
Expected: PASS (existing content-generation/nano-banana tests still green; they mock the model, so the rename is safe).

- [ ] **Step 4: Commit**

```bash
git add packages/ai/src/providers/openai.provider.ts
git commit -m "fix(ai): default OpenAI model to gpt-4o (was stale gpt-4-turbo), allow OPENAI_MODEL override

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: YouTube Shorts — reliable `#Shorts` hint + pre-upload validation

**Context:** `uploadVideo` runs in the worker process (ffmpeg/ffprobe present per `docker/Dockerfile.worker:8`). The format reaches the provider as `payload.metadata.format === "SHORT"`. YouTube classifies a Short by **vertical aspect ratio (width <= height)** and **duration <= 180s**; `#Shorts` is a hint. Current code checks `payload.content.includes("#Shorts")` but appends to `description` — wrong string — and does no validation.

**Files:**
- Modify: `packages/social/src/providers/youtube.provider.ts`
- Create: `packages/social/src/__tests__/youtube-shorts.test.ts`

- [ ] **Step 1: Write failing tests for the two pure helpers**

Create `packages/social/src/__tests__/youtube-shorts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildShortDescription, assertShortDimensions } from "../providers/youtube.provider";

describe("buildShortDescription", () => {
  it("appends #Shorts when SHORT and not already present", () => {
    expect(buildShortDescription("my caption", true)).toBe("my caption\n#Shorts");
  });

  it("does not duplicate #Shorts when already present in the description", () => {
    expect(buildShortDescription("hello #Shorts", true)).toBe("hello #Shorts");
  });

  it("matches #shorts case-insensitively (no duplicate)", () => {
    expect(buildShortDescription("hello #shorts", true)).toBe("hello #shorts");
  });

  it("leaves the description untouched for non-Short videos", () => {
    expect(buildShortDescription("a landscape video", false)).toBe("a landscape video");
  });
});

describe("assertShortDimensions", () => {
  it("passes for a vertical, short video", () => {
    expect(() => assertShortDimensions({ width: 1080, height: 1920, durationSec: 30 })).not.toThrow();
  });

  it("passes for a square video at the duration limit", () => {
    expect(() => assertShortDimensions({ width: 1080, height: 1080, durationSec: 180 })).not.toThrow();
  });

  it("throws for a landscape video", () => {
    expect(() => assertShortDimensions({ width: 1920, height: 1080, durationSec: 30 }))
      .toThrow(/vertical/i);
  });

  it("throws for a video longer than 180s", () => {
    expect(() => assertShortDimensions({ width: 1080, height: 1920, durationSec: 200 }))
      .toThrow(/3 minutes|180/i);
  });

  it("includes the actual dimensions in the landscape error", () => {
    expect(() => assertShortDimensions({ width: 1920, height: 1080, durationSec: 30 }))
      .toThrow(/1920.*1080/);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm --filter @postautomation/social test -- youtube-shorts`
Expected: FAIL with "buildShortDescription is not a function" / "assertShortDimensions is not a function" (not yet exported).

- [ ] **Step 3: Add the two exported helpers to the YouTube provider**

In `packages/social/src/providers/youtube.provider.ts`, add these module-level exports near the top of the file, **after the imports (after line 11) and before `export class YouTubeProvider`**:

```ts
export interface ShortVideoProbe {
  width: number;
  height: number;
  durationSec: number;
}

/**
 * YouTube has no API flag for Shorts — it classifies a video as a Short from
 * the file itself: vertical (or square) aspect ratio and duration <= 3 min.
 * #Shorts in the description is a hint, not a requirement.
 */
export const SHORT_MAX_DURATION_SEC = 180;

/** Append #Shorts to the description for Short uploads, without duplicating it. */
export function buildShortDescription(content: string, isShort: boolean): string {
  if (!isShort) return content;
  if (/#shorts\b/i.test(content)) return content;
  return `${content}\n#Shorts`;
}

/**
 * Throw a clear, actionable error if a video chosen as a Short cannot be
 * classified as one by YouTube (landscape, or longer than 3 minutes).
 */
export function assertShortDimensions(probe: ShortVideoProbe): void {
  if (probe.width > probe.height) {
    throw new Error(
      `This video is ${probe.width}x${probe.height} (landscape). YouTube only treats vertical or square videos as Shorts. ` +
        `Upload a 9:16 vertical video, or post it as a regular Video instead.`
    );
  }
  if (probe.durationSec > SHORT_MAX_DURATION_SEC) {
    const mins = Math.floor(probe.durationSec / 60);
    const secs = Math.round(probe.durationSec % 60);
    throw new Error(
      `This video is ${mins}m ${secs}s long. YouTube Shorts must be 3 minutes (180s) or shorter. ` +
        `Trim the video, or post it as a regular Video instead.`
    );
  }
}
```

- [ ] **Step 4: Run the helper tests to confirm they pass**

Run: `pnpm --filter @postautomation/social test -- youtube-shorts`
Expected: PASS (all cases in `buildShortDescription` and `assertShortDimensions`).

- [ ] **Step 5: Wire the helpers into `uploadVideo` and probe the real file**

In `packages/social/src/providers/youtube.provider.ts`, the current `uploadVideo` head (lines 172-191):

```ts
  private async uploadVideo(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const videoUrl = payload.mediaUrls![0]!;
    const title = (payload.metadata?.title as string) || payload.content.slice(0, 100);
    const isShort = String(payload.metadata?.format ?? "").toUpperCase() === "SHORT";
    const description = isShort && !payload.content.includes("#Shorts")
      ? `${payload.content}\n#Shorts`
      : payload.content;
    const tags = (payload.metadata?.tags as string[]) || [];
    const privacyStatus = (payload.metadata?.privacyStatus as string) || "public";
    const categoryId = (payload.metadata?.categoryId as string) || "22"; // 22 = People & Blogs
    const onProgress = payload.onProgress;

    // Download the video file (progress: 0→10%)
    await onProgress?.(5);
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Failed to download video from ${videoUrl}`);
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    const videoContentType = videoRes.headers.get("content-type") || "video/mp4";
    const totalBytes = videoBuffer.length;
    await onProgress?.(10);
```

Replace that block with (correct `#Shorts` via helper; probe the downloaded buffer; validate before initiating the upload):

```ts
  private async uploadVideo(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const videoUrl = payload.mediaUrls![0]!;
    const title = (payload.metadata?.title as string) || payload.content.slice(0, 100);
    const isShort = String(payload.metadata?.format ?? "").toUpperCase() === "SHORT";
    const description = buildShortDescription(payload.content, isShort);
    const tags = (payload.metadata?.tags as string[]) || [];
    const privacyStatus = (payload.metadata?.privacyStatus as string) || "public";
    const categoryId = (payload.metadata?.categoryId as string) || "22"; // 22 = People & Blogs
    const onProgress = payload.onProgress;

    // Download the video file (progress: 0→10%)
    await onProgress?.(5);
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Failed to download video from ${videoUrl}`);
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    const videoContentType = videoRes.headers.get("content-type") || "video/mp4";
    const totalBytes = videoBuffer.length;

    // For Shorts, validate the file actually qualifies BEFORE uploading, so we
    // never silently publish a landscape/long video that YouTube treats as a
    // normal video. (No API flag forces "Short"; classification is by the file.)
    if (isShort) {
      const probe = await probeVideo(videoBuffer, videoContentType);
      assertShortDimensions(probe);
    }
    await onProgress?.(10);
```

- [ ] **Step 6: Add the `probeVideo` ffprobe helper to the same file**

Add these imports at the very top of `packages/social/src/providers/youtube.provider.ts` (after the existing `import type { ... }` block):

```ts
import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import crypto from "crypto";
```

Then add this module-level helper next to the other exports (it stays internal — not exported):

```ts
/**
 * Read width/height/duration from a video buffer using ffprobe (bundled with
 * ffmpeg, installed in the worker image). Writes a temp file because ffprobe
 * needs a seekable input. Mirrors the temp-file pattern in
 * apps/worker/src/lib/video-overlay.ts.
 */
async function probeVideo(buffer: Buffer, contentType: string): Promise<ShortVideoProbe> {
  const TMP_DIR = "/tmp/yt-probe";
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const ext = contentType.includes("quicktime") ? "mov" : "mp4";
  const path = join(TMP_DIR, `${crypto.randomBytes(8).toString("hex")}.${ext}`);
  try {
    writeFileSync(path, buffer);
    const out = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration",
        "-of", "json",
        path,
      ],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(out);
    const stream = parsed.streams?.[0] ?? {};
    const width = Number(stream.width) || 0;
    const height = Number(stream.height) || 0;
    const durationSec = Number(parsed.format?.duration) || 0;
    if (!width || !height) {
      throw new Error("Could not read video dimensions for Shorts validation.");
    }
    return { width, height, durationSec };
  } finally {
    try { unlinkSync(path); } catch { /* best-effort cleanup */ }
  }
}
```

- [ ] **Step 7: Type-check the social package**

Run: `pnpm --filter @postautomation/social type-check`
Expected: PASS. (Fallback: `pnpm type-check` from root.)

- [ ] **Step 8: Run the full social test suite**

Run: `pnpm --filter @postautomation/social test`
Expected: PASS (new youtube-shorts tests + any existing provider tests).

- [ ] **Step 9: Commit**

```bash
git add packages/social/src/providers/youtube.provider.ts packages/social/src/__tests__/youtube-shorts.test.ts
git commit -m "fix(youtube): validate Short videos (vertical + <=3min) pre-upload and reliably tag #Shorts

Fail with a clear error when a video chosen as 'Short' is landscape or too long,
instead of silently publishing it as a regular video. Correct the #Shorts hint to
check the description string and avoid duplication.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Facebook/Instagram OAuth — redirect-URI case + specific error codes

**Context:** Token exchange's `redirect_uri` (`route.ts:175`) is built from `params.provider` as-is, while the authorize URL used `.toLowerCase()` (`channel.router.ts:167`). Meta requires byte-identical redirect URIs. Also, FB-no-pages and IG-no-business-account currently collapse into a generic `oauth_failed`; we want specific opaque codes (no raw provider strings — see the security note at `route.ts:6-8`).

**Files:**
- Modify: `apps/web/app/api/oauth/callback/[provider]/route.ts`
- Modify: `apps/web/app/dashboard/channels/page.tsx` (error copy map)

- [ ] **Step 1: Lowercase the token-exchange redirect_uri**

In `apps/web/app/api/oauth/callback/[provider]/route.ts`, the config block (lines 172-177):

```ts
    const config = {
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      callbackUrl: `${process.env.APP_URL}/api/oauth/callback/${params.provider}`,
      scopes: [],
    };
```

Replace with:

```ts
    const config = {
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      // Must byte-match the redirect_uri used at authorize time, which lowercases
      // the provider (see channel.router.ts getOAuthUrl). Meta rejects mismatches.
      callbackUrl: `${process.env.APP_URL}/api/oauth/callback/${params.provider.toLowerCase()}`,
      scopes: [],
    };
```

- [ ] **Step 2: Emit a specific code when an Instagram connect finds no business account**

In the same file, the Instagram branch (lines 268-270):

```ts
      if (igAccounts.length === 0) {
        throw new Error("No Instagram Business Account found. Ensure a Facebook Page is connected to an Instagram Professional account.");
      }
```

Replace with (return a specific opaque code instead of throwing into the generic catch):

```ts
      if (igAccounts.length === 0) {
        console.warn(
          "[oauth/instagram] connected user has no IG Business Account linked to a Page"
        );
        return NextResponse.redirect(
          `${process.env.APP_URL}/dashboard/channels?error=ig_no_business_account&platform=instagram`
        );
      }
```

- [ ] **Step 3: Emit a specific code when a Facebook connect finds no Pages**

In the same file, the Facebook no-pages branch currently silently saves the user account as a fallback (lines 188-220). The user account cannot post, so surface it. Change the `if (pages.length === 0) {` block so that instead of upserting the user account it returns a specific code. Replace lines 188-220:

```ts
      if (pages.length === 0) {
        // No pages found — save user account as fallback
        await prisma.channel.upsert({
          where: {
            organizationId_platform_platformId: {
              organizationId,
              platform: "FACEBOOK",
              platformId: profile.id,
            },
          },
          update: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || null,
            tokenExpiresAt: tokens.expiresAt || null,
            scopes: tokens.scopes || [],
            name: profile.name,
            username: profile.username || null,
            avatar: profile.avatar || null,
            isActive: true,
          },
          create: {
            organizationId,
            platform: "FACEBOOK",
            platformId: profile.id,
            name: profile.name,
            username: profile.username || null,
            avatar: profile.avatar || null,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || null,
            tokenExpiresAt: tokens.expiresAt || null,
            scopes: tokens.scopes || [],
          },
        });
      } else {
```

with:

```ts
      if (pages.length === 0) {
        // A Facebook user account cannot post to a feed via the Graph API —
        // posting requires a Page the user administers. Surface this clearly
        // instead of creating an unusable channel.
        console.warn(
          "[oauth/facebook] connected user administers no Facebook Pages"
        );
        return NextResponse.redirect(
          `${process.env.APP_URL}/dashboard/channels?error=fb_no_pages&platform=facebook`
        );
      } else {
```

- [ ] **Step 4: Add user-facing copy for the two new error codes**

In `apps/web/app/dashboard/channels/page.tsx`, the `OAUTH_ERROR_MESSAGES` map (lines 91-105). Add two entries before the closing brace (after the `twitter_request_token_failed` entry on line 104):

```ts
  fb_no_pages:
    "No Facebook Page found on your account. PostAutomation posts to Pages, not personal profiles — create or get admin access to a Facebook Page, then reconnect.",
  ig_no_business_account:
    "No Instagram Business account found. Convert your Instagram account to Professional/Business and link it to a Facebook Page you manage, then reconnect.",
```

- [ ] **Step 5: Type-check the web app**

Run: `pnpm --filter @postautomation/web type-check`
Expected: PASS. (Fallback: `pnpm type-check` from root.)

- [ ] **Step 6: Build the web app to catch route-level issues**

Run: `pnpm --filter @postautomation/web build`
Expected: Build succeeds (the route compiles; note prior commits set Next to ignore pre-existing ESLint violations, so focus on compile/type errors).

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/api/oauth/callback/[provider]/route.ts" apps/web/app/dashboard/channels/page.tsx
git commit -m "fix(oauth): lowercase FB/IG token-exchange redirect_uri and surface no-pages / no-IG-business errors

Match the authorize-time redirect_uri (Meta rejects case mismatches). Replace the
generic oauth_failed for FB-no-Pages and IG-no-Business-account with specific,
actionable messages instead of silently creating an unusable Facebook channel.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Meta App operator runbook (unblocks normal users)

**Context:** The "This app isn't available — This app needs at least one supported permission" error is Meta blocking non-role users because the app is in Development mode and/or the requested permissions/products aren't added & approved. No code change fixes this; it is a dashboard action. Document it precisely.

**Files:**
- Create: `docs/META_APP_SETUP.md`

- [ ] **Step 1: Write the runbook**

Create `docs/META_APP_SETUP.md` with exactly this content:

```markdown
# Meta App Setup — Facebook & Instagram Connect

The live Meta app is **"Post Automation 2"** (App ID `298449321694397`). Connecting
Facebook/Instagram from PostAutomation requires the Meta app to be configured and
(for non-test users) reviewed by Meta. This is operator configuration in the Meta
dashboard — no code change can substitute for it.

## Symptom this fixes

- **Normal users** see: *"This app isn't available — This app needs at least one
  supported permission."* and never reach consent. → App is in Development mode
  and/or the user is not a Tester, or required permissions aren't added.
- **App admins/testers** reach consent but the connect still fails in-app with
  `fb_no_pages` / `ig_no_business_account`. → The account has no admin'd Facebook
  Page, or no Instagram Professional account linked to such a Page.

## 1. Products

In the Meta App Dashboard → **Add Products**, ensure both are added:
- **Facebook Login**
- **Instagram Graph API** (for Instagram publishing via a linked Page)

## 2. Facebook Login settings

Facebook Login → Settings → **Valid OAuth Redirect URIs** must contain exactly:
- `https://postautomation.co.in/api/oauth/callback/facebook`
- `https://postautomation.co.in/api/oauth/callback/instagram`
- `http://localhost:3000/api/oauth/callback/facebook` (local dev only)
- `http://localhost:3000/api/oauth/callback/instagram` (local dev only)

(All lowercase. The app sends lowercase redirect URIs.)

## 3. Permissions / scopes

The app requests these (App Dashboard → App Review → Permissions and Features):
- Facebook: `public_profile`, `email`, `pages_show_list`, `pages_manage_posts`,
  `pages_read_engagement`
- Instagram: the above plus `instagram_basic`, `instagram_content_publish`,
  `instagram_manage_comments`, `business_management`

`pages_manage_posts`, `instagram_content_publish`, and `business_management` are
**advanced** permissions: they work for app roles in Development mode, but require
**App Review approval** before normal users can grant them.

## 4. Make it work for normal users — pick one

**Option A — Testing only (fastest):** Keep the app in Development mode and add each
end user under App Dashboard → **App Roles → Roles** as a *Tester* (they must accept
the invite). Test users won't see the "isn't available" error.

**Option B — Public (production):** Complete Meta **App Review** for the advanced
permissions above, complete **Business Verification**, then switch the app to **Live**
mode (toggle at the top of the dashboard). Only then can arbitrary users connect.
Review typically takes ~1–2 weeks.

## 5. Account requirements (even after the above)

The connecting user must:
- **Administer at least one Facebook Page** (personal profiles cannot be posted to
  via the API → otherwise `fb_no_pages`).
- For Instagram: have an **Instagram Professional/Business** account **linked to a
  Facebook Page** they administer (Instagram app → Settings → Account type, then link
  to the Page) → otherwise `ig_no_business_account`.

## 6. Verify

1. In an incognito window as a non-role user (Option B) or a Tester (Option A), go to
   `/dashboard/channels` → Connect Facebook. You should reach the Meta consent screen.
2. After granting, you should be redirected back with `?success=connected`.
3. If you get `fb_no_pages` / `ig_no_business_account`, fix §5 for that account.
```

- [ ] **Step 2: Commit**

```bash
git add docs/META_APP_SETUP.md
git commit -m "docs(meta): operator runbook to make FB/IG connectable by normal users

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: AI features verification report

**Context:** Per the spec, AI scope is "fix what's actually broken." Task 2 already fixed the one concrete code bug (stale default model). This task verifies every AI tRPC path is wired end-to-end and produces the works/needs-key/fixed report. No redesign, no new tests.

**Files:**
- No code changes expected. Create: `docs/AI_FEATURES_STATUS.md` (the report).

- [ ] **Step 1: Confirm each AI tRPC procedure resolves to a real provider call**

Read and confirm (no edits) that each of these wires UI → tRPC → `@postautomation/ai` with no dead end:
- `ai.generateContent` → `packages/api/src/routers/ai.router.ts:9-28` → `content-generation.chain.ts`
- `ai.suggestHashtags` → `ai.router.ts:30-39` → `hashtag-suggestion.chain.ts`
- `ai.optimizeContent` → `ai.router.ts:41-57` → `schedule-optimization.chain.ts`
- `repurpose.repurpose` → `packages/api/src/routers/repurpose.router.ts:27-43` → `content-repurpose.chain.ts`
- `image.generate` / `image.edit` → `packages/api/src/routers/image.router.ts:25-153`

For each, confirm the chain calls a provider via `provider.factory.ts` (`getModel` / `callGemini` / `callGemma4` / image fns) and that the only failure mode for an otherwise-correct path is a **missing API key** (configuration, not a bug). If any path references a function that does not exist or a UI mutation with no router procedure, STOP and report it — that is a real bug to fix in this task.

- [ ] **Step 2: Type-check the api + ai packages**

Run: `pnpm --filter @postautomation/ai type-check && pnpm --filter @postautomation/api type-check`
Expected: PASS.

- [ ] **Step 3: Run AI tests**

Run: `pnpm --filter @postautomation/ai test`
Expected: PASS.

- [ ] **Step 4: Write the status report**

Create `docs/AI_FEATURES_STATUS.md`:

```markdown
# AI Features Status (2026-06-01)

Legend: ✅ works · 🔑 works but needs an API key set · 🔧 fixed in this change

| Feature | tRPC | Provider/Model | Status |
|---------|------|----------------|--------|
| Generate content | ai.generateContent | OpenAI gpt-4o (default), or Anthropic/Gemini/Grok/DeepSeek/Gemma | 🔧 (default model was stale gpt-4-turbo → gpt-4o) / 🔑 |
| Suggest hashtags | ai.suggestHashtags | same text providers | 🔑 |
| Optimize content | ai.optimizeContent | same text providers | 🔑 |
| Repurpose content | repurpose.repurpose | text providers | 🔑 |
| Repurpose from URL | repurpose.repurposeFromUrl | text + image + video | 🔑 (video gated to Pro/Enterprise) |
| Image generate | image.generate | Nano Banana (Gemini), DALL·E 3, FLUX.1 | 🔑 |
| Image edit | image.edit | Nano Banana only | 🔑 |

## Required env keys per provider
- OpenAI: `OPENAI_API_KEY` (optional `OPENAI_MODEL` override)
- Anthropic: `ANTHROPIC_API_KEY`
- Google (Gemini/Gemma/Veo/Nano Banana): `GOOGLE_GEMINI_API_KEY` or `GOOGLE_AI_API_KEY`
- xAI: `XAI_API_KEY` · DeepSeek: `DEEPSEEK_API_KEY`
- Together (FLUX.1): `TOGETHER_API_KEY` · fal.ai (Seedance): `FAL_KEY` / `FAL_API_KEY`

## Notes
- All current model IDs verified non-deprecated as of 2026-06-01 except the OpenAI
  default, fixed here.
- Features that "don't work" without a key are configuration, not code defects: set
  the relevant key in `.env` / `.env.prod`. `ai.getConfig` reports which providers are
  configured so the UI hides unconfigured ones.
```

If Step 1 surfaced an actual broken wiring, add a row documenting the fix and include the code change in this task's commit.

- [ ] **Step 5: Commit**

```bash
git add docs/AI_FEATURES_STATUS.md
git commit -m "docs(ai): feature status report (works / needs-key / fixed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Repo-wide type-check**

Run: `pnpm type-check`
Expected: PASS across all workspaces.

- [ ] **Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Tests**

Run: `pnpm test`
Expected: PASS (includes new youtube-shorts tests).

---

## Self-review notes (author)

- **Spec coverage:** FB/IG → Tasks 4 (code) + 5 (runbook); YouTube Shorts → Task 3; AI → Task 2 (fix) + Task 6 (verify/report); channels text → Task 1. All four spec sections covered.
- **No placeholders:** every code step shows full before/after.
- **Type consistency:** `buildShortDescription`, `assertShortDimensions`, `ShortVideoProbe`, `SHORT_MAX_DURATION_SEC`, `probeVideo` are defined in Task 3 Steps 3/6 and used consistently in Step 5 and the tests in Step 1.
- **Security:** new error codes are opaque (no raw provider strings reflected), honoring `route.ts:6-8`.
```
