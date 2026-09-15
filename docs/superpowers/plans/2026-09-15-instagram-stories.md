# Instagram Stories in Content Studio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class "Story" post type to Content Studio → Compose that publishes one image or video as an Instagram Story (with `@username` mentions) to one or many Instagram channels, without changing any non-story request or behaviour.

**Architecture:** Post-level Story mode reuses the existing `PostTarget.format = "STORY"` column (already forwarded to providers as `metadata.format`) and stores mentions on `Post.metadata.instagramStory`. The Instagram provider gains the image-`STORIES` container, `user_tags`, a story-aware duplicate-reconciliation path (`GET /{ig-user}/stories`), and a story permalink fallback. Analytics is bounded to the story's 24h life. The Compose UI gets a Post | Story switch that filters channels/groups to Instagram, a Tag-people card, a 9:16 story preview, and story-aware submit gating. Spec: [2026-09-15-instagram-stories-design.md](../specs/2026-09-15-instagram-stories-design.md).

**Tech Stack:** TypeScript, Next.js (apps/web), tRPC + zod (packages/api), Prisma (no schema change), BullMQ worker (apps/worker), Meta Graph API v18 via `fetch`, Vitest.

**Conventions that apply to every task**
- Package manager is `pnpm`. Run a single test file with `npx vitest run <name-fragment>` from the repo root.
- Never key a ComposeTab effect on the `postMedia` array identity; never put a video URL in `<img>`; route preview media through `PreviewMedia`; classify video only via `isVideoMediaItem` / `VIDEO_EXT_RE`.
- Every change to a publish request must leave the non-story request byte-identical; tests assert that explicitly.
- Commit after each task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| file | responsibility |
|---|---|
| `packages/social/src/utils/instagram-story.ts` (create) | pure story helpers for the provider: format detection, mentions → `user_tags`, story permalink fallback, exactly-one candidate picker |
| `packages/social/src/__tests__/instagram-story.test.ts` (create) | unit tests for the helpers |
| `packages/social/src/__tests__/instagram-story-publish.test.ts` (create) | fetch-mocked provider tests: container body, byte-identity, reconciliation via `/stories` |
| `packages/social/src/providers/instagram.provider.ts` (modify) | image `STORIES` container, `user_tags`, story reconciliation, story URL, pre-flight `null` for stories |
| `apps/worker/src/lib/story-analytics.ts` (create) | pure: at-age windows per format, expired-story `where` fragment |
| `apps/worker/src/__tests__/story-analytics.test.ts` (create) | tests |
| `apps/worker/src/workers/post-publish.worker.ts` (modify) | `channelUsername` for stories, skip AI auto-image for stories, at-age windows per format |
| `apps/worker/src/scheduler/cron-jobs.ts` (modify) | exclude expired stories from the two recurring passes; skip non-24h checkpoints for stories in reconciliation |
| `packages/api/src/lib/instagram-story.ts` (create) | pure: zod input, `normalizeStoryMentions`, `validateStoryPost` |
| `packages/api/src/__tests__/instagram-story-create.test.ts` (create) | tests |
| `packages/api/src/routers/post.router.ts` (modify) | `story` input on `create`; story validation; forced `format: "STORY"`; `instagramStory` metadata; `update` keeps story posts IG-only + STORY |
| `apps/web/lib/instagram-story.ts` (create) | pure UI helpers: channel filtering, selection pruning, group ids, mention parsing, block reason |
| `apps/web/lib/instagram-story.test.ts` (create) | tests |
| `apps/web/lib/active-task.tsx` (modify) | draft gains `postType` + `storyMentions` |
| `apps/web/components/previews/instagram-story-preview.tsx` (create) | 9:16 story preview |
| `apps/web/components/content-agent/ComposeTab.tsx` (modify) | Post \| Story switch and all story-mode behaviour |
| `apps/web/app/dashboard/posts/[id]/page.tsx`, `apps/web/components/content-agent/PostsTab.tsx` (modify) | "Story" badge |
| `CLAUDE.md`, memory (modify) | document |

---

### Task 1: Story helpers in packages/social (pure)

**Files:**
- Create: `packages/social/src/utils/instagram-story.ts`
- Test: `packages/social/src/__tests__/instagram-story.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/social/src/__tests__/instagram-story.test.ts
import { describe, it, expect } from "vitest";
import {
  isStoryFormat,
  readStoryMentions,
  buildStoryUserTags,
  storyPermalinkFallback,
  pickStoryCandidate,
  IG_USERNAME_RE,
  STORY_MAX_MENTIONS,
} from "../utils/instagram-story";

describe("isStoryFormat", () => {
  it("is true only for format STORY (case-insensitive)", () => {
    expect(isStoryFormat({ format: "STORY" })).toBe(true);
    expect(isStoryFormat({ format: "story" })).toBe(true);
    expect(isStoryFormat({ format: "REEL" })).toBe(false);
    expect(isStoryFormat({})).toBe(false);
    expect(isStoryFormat(undefined)).toBe(false);
  });
});

describe("readStoryMentions / buildStoryUserTags", () => {
  it("returns null when there is nothing to send — the byte-identical path", () => {
    expect(buildStoryUserTags(undefined)).toBeNull();
    expect(buildStoryUserTags({})).toBeNull();
    expect(buildStoryUserTags({ instagramStory: {} })).toBeNull();
    expect(buildStoryUserTags({ instagramStory: { mentions: [] } })).toBeNull();
    expect(buildStoryUserTags({ instagramStory: { mentions: "natgeo" } })).toBeNull();
  });

  it("maps valid usernames to {username} objects, stripping a leading @", () => {
    expect(buildStoryUserTags({ instagramStory: { mentions: ["natgeo", "@nasa"] } })).toEqual([
      { username: "natgeo" },
      { username: "nasa" },
    ]);
  });

  it("drops malformed usernames (defense in depth — metadata comes from the DB)", () => {
    // Anything outside [A-Za-z0-9._]{1,30} never reaches a Graph request body.
    const tags = readStoryMentions({
      instagramStory: {
        mentions: ["ok.user", "has space", 'quote"x', "<script>", "", "a".repeat(31), 42 as unknown as string],
      },
    });
    expect(tags).toEqual(["ok.user"]);
  });

  it("dedupes case-insensitively and caps at STORY_MAX_MENTIONS", () => {
    const many = Array.from({ length: 30 }, (_, i) => `user${i}`);
    expect(readStoryMentions({ instagramStory: { mentions: ["NatGeo", "natgeo", ...many] } })).toHaveLength(
      STORY_MAX_MENTIONS
    );
    expect(readStoryMentions({ instagramStory: { mentions: ["NatGeo", "natgeo"] } })).toEqual(["NatGeo"]);
  });

  it("IG_USERNAME_RE matches Instagram's username charset", () => {
    for (const ok of ["a", "user.name", "user_name", "USER123", "a".repeat(30)]) expect(IG_USERNAME_RE.test(ok), ok).toBe(true);
    for (const bad of ["", "user-name", "user name", "@user", "a".repeat(31), "user!"]) expect(IG_USERNAME_RE.test(bad), bad).toBe(false);
  });
});

describe("storyPermalinkFallback", () => {
  it("builds the /stories/{username}/{id}/ URL when the username is usable", () => {
    expect(storyPermalinkFallback("nat.geo", "17900000000000000")).toBe(
      "https://www.instagram.com/stories/nat.geo/17900000000000000/"
    );
  });
  it("never emits a /p/ URL (a 404 for stories) and never interpolates junk", () => {
    expect(storyPermalinkFallback(undefined, "1")).toBe("https://www.instagram.com/");
    expect(storyPermalinkFallback("bad name", "1")).toBe("https://www.instagram.com/");
    expect(storyPermalinkFallback("ok", 'x"y')).toBe("https://www.instagram.com/");
  });
});

describe("pickStoryCandidate — three outcomes stay distinct", () => {
  const since = new Date("2026-09-15T10:00:00Z");
  const row = (id: string, minutesAfter: number, media_type: "IMAGE" | "VIDEO", permalink?: string) => ({
    id,
    timestamp: new Date(since.getTime() + minutesAfter * 60_000).toISOString(),
    media_type,
    ...(permalink ? { permalink } : {}),
  });

  it("adopts when exactly one story of the right kind was created inside the window", () => {
    const r = pickStoryCandidate([row("s1", 1, "IMAGE", "https://www.instagram.com/stories/u/s1/"), row("old", -5, "IMAGE")], since, "IMAGE");
    expect(r).toEqual({ outcome: "match", story: { id: "s1", permalink: "https://www.instagram.com/stories/u/s1/" } });
  });

  it("ignores stories of the other media kind", () => {
    expect(pickStoryCandidate([row("v1", 1, "VIDEO")], since, "IMAGE")).toEqual({ outcome: "none" });
  });

  it("reports 'many' instead of guessing when several candidates exist", () => {
    expect(pickStoryCandidate([row("a", 1, "IMAGE"), row("b", 2, "IMAGE")], since, "IMAGE")).toEqual({ outcome: "many", count: 2 });
  });

  it("tolerates malformed rows", () => {
    expect(pickStoryCandidate([{ id: "x" }, { timestamp: "nope", media_type: "IMAGE", id: "y" }, null as any], since, "IMAGE")).toEqual({ outcome: "none" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run instagram-story.test`
Expected: FAIL — `Cannot find module '../utils/instagram-story'`.

- [ ] **Step 3: Implement the helpers**

```ts
// packages/social/src/utils/instagram-story.ts
/**
 * Instagram STORIES publishing helpers (2026-09-15).
 *
 * A story is an ordinary media container with `media_type: "STORIES"`; the
 * Content Publishing API accepts `user_tags=[{username}]` on image AND video
 * story containers ("mentioning users without a sticker is supported"; x/y are
 * optional for stories). Everything here is pure so the provider's request
 * shape can be unit-tested without the network.
 *
 * ⚠️ Absent story metadata must leave every provider call byte-identical — the
 * IG publish path is contractually frozen. Every helper therefore returns
 * null / false / "none" for non-story input.
 */

/** Instagram username charset: letters, digits, dot, underscore; 1–30 chars. */
export const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

/** Cap on mentions per story — mirrors the caption @-tag limit Meta documents. */
export const STORY_MAX_MENTIONS = 20;

/** Media kinds a story can carry; matches IG Media `media_type` for stories. */
export type StoryMediaKind = "IMAGE" | "VIDEO";

export function isStoryFormat(metadata: Record<string, unknown> | undefined | null): boolean {
  return String((metadata as { format?: unknown } | null | undefined)?.format ?? "").toUpperCase() === "STORY";
}

/**
 * Usernames from `metadata.instagramStory.mentions`, cleaned: leading `@`
 * stripped, malformed entries dropped, case-insensitive dedupe (first spelling
 * wins), capped at STORY_MAX_MENTIONS. Defense in depth — the same validation
 * runs in post.create, but this value comes back out of the DB.
 */
export function readStoryMentions(metadata: Record<string, unknown> | undefined | null): string[] {
  const raw = (metadata as { instagramStory?: { mentions?: unknown } } | null | undefined)?.instagramStory?.mentions;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const username = item.trim().replace(/^@/, "");
    if (!IG_USERNAME_RE.test(username)) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(username);
    if (out.length >= STORY_MAX_MENTIONS) break;
  }
  return out;
}

/**
 * The `user_tags` value for a STORIES container, or null when there is nothing
 * to send (so the request stays byte-identical to an untagged story).
 * Sent as a real JSON array in the JSON body — the same way the carousel path
 * already sends `children`.
 */
export function buildStoryUserTags(
  metadata: Record<string, unknown> | undefined | null
): Array<{ username: string }> | null {
  const mentions = readStoryMentions(metadata);
  return mentions.length > 0 ? mentions.map((username) => ({ username })) : null;
}

/**
 * Story URL when Meta returns no `permalink`. `/p/{id}` is a 404 for stories, so
 * fall back to the account's stories path, and to the site root when the
 * username is unusable — never interpolate an unvalidated value into a URL.
 */
export function storyPermalinkFallback(username: unknown, mediaId: string): string {
  const u = typeof username === "string" ? username.trim().replace(/^@/, "") : "";
  if (!IG_USERNAME_RE.test(u) || !/^\d+$/.test(mediaId)) return "https://www.instagram.com/";
  return `https://www.instagram.com/stories/${u}/${mediaId}/`;
}

export type StoryCandidate =
  | { outcome: "match"; story: { id: string; permalink?: string } }
  | { outcome: "none" }
  | { outcome: "many"; count: number };

/**
 * Reconciliation for a story whose `media_publish` outcome is unknown.
 * `GET /{ig-user}/stories` lists the account's LIVE stories; a story created at
 * or after `since` with the media kind we sent is ours — but only when it is the
 * ONLY such story. Two candidates means we cannot tell which is ours (or whether
 * either is), and the caller must treat that as ambiguous, never as "adopt one".
 */
export function pickStoryCandidate(
  rows: Array<{ id?: unknown; timestamp?: unknown; media_type?: unknown; permalink?: unknown } | null | undefined>,
  since: Date,
  kind: StoryMediaKind
): StoryCandidate {
  const matches: Array<{ id: string; permalink?: string }> = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || typeof row.timestamp !== "string") continue;
    const when = new Date(row.timestamp);
    if (Number.isNaN(when.getTime()) || when.getTime() < since.getTime()) continue;
    if (String(row.media_type ?? "").toUpperCase() !== kind) continue;
    matches.push({
      id: row.id,
      ...(typeof row.permalink === "string" && row.permalink ? { permalink: row.permalink } : {}),
    });
  }
  if (matches.length === 1) return { outcome: "match", story: matches[0]! };
  if (matches.length === 0) return { outcome: "none" };
  return { outcome: "many", count: matches.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run instagram-story.test`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add packages/social/src/utils/instagram-story.ts packages/social/src/__tests__/instagram-story.test.ts
git commit -m "feat(social): pure Instagram story helpers (user_tags, permalink fallback, candidate picker)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Instagram provider — image stories, user_tags, story-aware reconciliation

**Files:**
- Modify: `packages/social/src/providers/instagram.provider.ts` (publishPost ~L129-193, createMediaContainer ~L679-700, publishContainer ~L709-825, resolveUnknownPublish ~L837-867, findExistingPost ~L940-949)
- Test: `packages/social/src/__tests__/instagram-story-publish.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/social/src/__tests__/instagram-story-publish.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";

/**
 * Instagram STORIES publishing (2026-09-15). Locks:
 *   1. an image story is a STORIES container with image_url (+ user_tags when
 *      mentions exist); a video story is STORIES with video_url and NEVER a
 *      cover_url;
 *   2. a NON-story image request is byte-identical to the pre-feature body;
 *   3. a story with >1 media throws BEFORE any network call (a carousel is not a
 *      story);
 *   4. duplicate prevention for stories reads /stories, never /media, adopts
 *      exactly-one candidate, and otherwise parks as ambiguous;
 *   5. the pre-write pre-flight never adopts anything for a story.
 */

const IG_USER = "17841400000000000";

interface Call { url: string; method: string; body: any }

function mockGraph(handler: (url: string, method: string) => { ok: boolean; status?: number; body: any }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      let body: any = undefined;
      try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      calls.push({ url: String(url), method, body });
      const { ok, body: res, status } = handler(String(url), method);
      return { ok, status: status ?? (ok ? 200 : 400), json: async () => res, headers: { get: () => null } } as any;
    })
  );
  return calls;
}

function instantSleep() {
  vi.stubGlobal("setTimeout", ((fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; }) as unknown as typeof setTimeout);
}

const happyGraph = (onContainer?: (body: any) => void) =>
  mockGraph((url, method) => {
    if (url.includes("/media_publish")) return { ok: true, body: { id: "9001" } };
    if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "container-1" } };
    if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
    if (url.includes("fields=permalink")) return { ok: true, body: {} }; // no permalink for stories
    return { ok: true, body: {} };
  });

const containerBody = (calls: Call[]) =>
  calls.find((c) => c.method === "POST" && c.url.includes(`/${IG_USER}/media`) && !c.url.includes("media_publish"))!.body;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Instagram story containers", () => {
  it("image story → media_type STORIES + image_url + user_tags", async () => {
    const calls = happyGraph();
    instantSleep();
    const res = await new InstagramProvider().publishPost({ accessToken: "t" }, {
      content: "",
      mediaUrls: ["https://cdn.example.com/a.jpg"],
      mediaTypes: ["image/jpeg"],
      metadata: { igUserId: IG_USER, format: "STORY", instagramStory: { mentions: ["natgeo", "@nasa"] }, channelUsername: "myacct" },
    });
    expect(containerBody(calls)).toEqual({
      caption: "",
      image_url: "https://cdn.example.com/a.jpg",
      media_type: "STORIES",
      user_tags: [{ username: "natgeo" }, { username: "nasa" }],
      access_token: "t",
    });
    expect(res.platformPostId).toBe("9001");
    // No permalink from Meta → the /stories/ fallback, never /p/.
    expect(res.url).toBe("https://www.instagram.com/stories/myacct/9001/");
  });

  it("image story without mentions sends no user_tags key", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost({ accessToken: "t" }, {
      content: "note",
      mediaUrls: ["https://cdn.example.com/a.jpg"],
      mediaTypes: ["image/jpeg"],
      metadata: { igUserId: IG_USER, format: "STORY", instagramStory: { mentions: [] } },
    });
    expect(containerBody(calls)).toEqual({
      caption: "note",
      image_url: "https://cdn.example.com/a.jpg",
      media_type: "STORIES",
      access_token: "t",
    });
  });

  it("video story → STORIES + video_url + user_tags, and NEVER cover_url", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost({ accessToken: "t" }, {
      content: "",
      mediaUrls: ["https://cdn.example.com/v.mp4"],
      mediaTypes: ["video/mp4"],
      metadata: {
        igUserId: IG_USER,
        format: "STORY",
        instagramStory: { mentions: ["friend"] },
        videoThumbnail: { mediaId: "m", url: "https://cdn.example.com/cover.jpg" },
      },
    });
    const body = containerBody(calls);
    expect(body.media_type).toBe("STORIES");
    expect(body.video_url).toBe("https://cdn.example.com/v.mp4");
    expect(body.user_tags).toEqual([{ username: "friend" }]);
    expect(body).not.toHaveProperty("cover_url");
  });

  it("a NON-story image request is byte-identical to the pre-feature body", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost({ accessToken: "t" }, {
      content: "hello",
      mediaUrls: ["https://cdn.example.com/a.jpg"],
      mediaTypes: ["image/jpeg"],
      metadata: { igUserId: IG_USER },
    });
    expect(Object.keys(containerBody(calls))).toEqual(["caption", "image_url", "access_token"]);
  });

  it("a story with more than one attachment throws before any network call", async () => {
    const calls = happyGraph();
    await expect(
      new InstagramProvider().publishPost({ accessToken: "t" }, {
        content: "",
        mediaUrls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
        mediaTypes: ["image/jpeg", "image/jpeg"],
        metadata: { igUserId: IG_USER, format: "STORY" },
      })
    ).rejects.toThrow(/exactly one image or video/);
    expect(calls).toHaveLength(0);
  });
});

describe("Instagram story duplicate prevention", () => {
  const TRANSIENT = { error: { message: "Please retry", type: "OAuthException", is_transient: true, code: 2 } };
  const storyPayload = { content: "", mediaUrls: ["https://cdn.example.com/a.jpg"], mediaTypes: ["image/jpeg"], metadata: { igUserId: IG_USER, format: "STORY", channelUsername: "acct" } };

  it("adopts the single live story created in the window instead of re-publishing", async () => {
    const calls = mockGraph((url, method) => {
      if (url.includes("/media_publish")) return { ok: false, body: TRANSIENT };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "c1" } };
      if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes(`/${IG_USER}/stories`)) {
        return { ok: true, body: { data: [{ id: "555", timestamp: new Date().toISOString(), media_type: "IMAGE", permalink: "https://www.instagram.com/stories/acct/555/" }] } };
      }
      return { ok: true, body: {} };
    });
    instantSleep();
    const res = await new InstagramProvider().publishPost({ accessToken: "t" }, storyPayload);
    expect(res.platformPostId).toBe("555");
    expect(res.url).toBe("https://www.instagram.com/stories/acct/555/");
    // Never consults /media for a story (a same-caption FEED post must not be adopted).
    expect(calls.some((c) => c.url.includes(`/${IG_USER}/media?`))).toBe(false);
    expect(calls.filter((c) => c.method === "POST" && c.url.includes(`/${IG_USER}/media`) && !c.url.includes("media_publish"))).toHaveLength(1);
  });

  it("parks as ambiguous when zero or several candidate stories exist", async () => {
    for (const data of [[], [{ id: "a", timestamp: new Date().toISOString(), media_type: "IMAGE" }, { id: "b", timestamp: new Date().toISOString(), media_type: "IMAGE" }]]) {
      mockGraph((url, method) => {
        if (url.includes("/media_publish")) return { ok: false, body: TRANSIENT };
        if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "c1" } };
        if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
        if (url.includes(`/${IG_USER}/stories`)) return { ok: true, body: { data } };
        return { ok: true, body: {} };
      });
      instantSleep();
      await expect(new InstagramProvider().publishPost({ accessToken: "t" }, storyPayload)).rejects.toSatisfy((e: unknown) => isAmbiguousPublishError(e));
      vi.unstubAllGlobals();
    }
  });

  it("the pre-write pre-flight never adopts anything for a story", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { data: [{ id: "x", timestamp: new Date().toISOString(), media_type: "IMAGE" }] } }));
    const res = await new InstagramProvider().findExistingPost!({ accessToken: "t" }, storyPayload, new Date(Date.now() - 60_000));
    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run instagram-story-publish`
Expected: FAIL — image story body has no `media_type`, `user_tags`; url is `/p/9001`; duplicate test calls `/media?`.

- [ ] **Step 3: Implement — imports and publishPost**

At the top of `instagram.provider.ts`, after the `video-thumbnail` import (line 3), add:

```ts
import {
  isStoryFormat,
  buildStoryUserTags,
  storyPermalinkFallback,
  pickStoryCandidate,
  type StoryMediaKind,
} from "../utils/instagram-story";
```

Replace the body of `publishPost` (lines 129–193) with:

```ts
  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const igUserId = (payload.metadata?.igUserId as string) || (await this.getInstagramBusinessAccountId(tokens));

    // Story mode (2026-09-15): every target of a story post carries
    // PostTarget.format = "STORY", which the worker forwards as metadata.format.
    // Absent ⇒ every branch below is the pre-feature request.
    const isStory = isStoryFormat(payload.metadata);

    if (payload.mediaUrls && payload.mediaUrls.length > 1) {
      if (isStory) {
        // A carousel is a FEED post. Refuse before any network call rather than
        // silently publishing the wrong thing.
        throw new Error(
          `An Instagram story takes exactly one image or video — this post has ${payload.mediaUrls.length} attachments.`
        );
      }
      return this.publishCarouselPost(tokens, payload, igUserId);
    }

    // Single image or single video post
    const mediaUrl = payload.mediaUrls?.[0];
    if (!mediaUrl || !mediaUrl.startsWith("http")) {
      throw new Error("Instagram requires a valid publicly accessible media URL to publish a post.");
    }

    // Detect if this is a video
    const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(mediaUrl) ||
      (payload.mediaTypes?.[0] ?? "").startsWith("video/");

    // Step 1: Create a media container (image_url for images, video_url for videos)
    const containerParams: Record<string, unknown> = {
      caption: payload.content,
    };

    if (isVideo) {
      containerParams["video_url"] = mediaUrl;
      const fmt = String(payload.metadata?.format ?? "REEL").toUpperCase();
      const mediaType = fmt === "STORY" ? "STORIES" : "REELS";
      containerParams["media_type"] = mediaType;

      // Optional user-uploaded cover. Meta cURLs `cover_url` server-side exactly
      // as it already cURLs `video_url`, so this costs no extra request and needs
      // no new permission — instagram_content_publish already covers it.
      //
      // ⚠️ REELS ONLY. cover_url on a STORIES container 400s container creation
      // and fails the whole publish, so the gate is on the resolved media_type,
      // never on "is this a video".
      //
      // ⚠️ When absent, containerParams is byte-identical to the pre-feature
      // request — the IG publish path is contractually frozen.
      const coverUrl = resolveVideoThumbnailUrl(payload.metadata);
      if (coverUrl && supportsInstagramCover(mediaType)) {
        containerParams["cover_url"] = coverUrl;
      }
    } else {
      containerParams["image_url"] = mediaUrl;
      // Image STORY: the only difference from a feed image is media_type=STORIES.
      // (Video stories already set it above.)
      if (isStory) containerParams["media_type"] = "STORIES";
    }

    // Mentions ride on user_tags for image AND video stories (Meta: "Required for
    // user tagging in images, videos, and stories"; x/y optional for stories).
    // null when there are no mentions, so the untagged request is unchanged.
    if (isStory) {
      const userTags = buildStoryUserTags(payload.metadata);
      if (userTags) containerParams["user_tags"] = userTags;
    }

    const containerId = await this.createMediaContainer(tokens, igUserId, containerParams);

    // Wait for the container to reach FINISHED before publishing. Instagram
    // processes ALL media asynchronously — not just videos. Publishing an image
    // container too soon returns OAuthException code 9007 / subcode 2207027
    // ("Media ID is not available / The media is not ready to be published").
    // Videos can take 30-90s; images are usually a few seconds but are NOT
    // instant, especially larger files. Poll faster (2s) and shorter (30s) for
    // images so the common case stays snappy; keep the long 90s budget for video.
    await this.waitForMediaReady(
      tokens,
      containerId,
      isVideo ? VIDEO_READY_TIMEOUT_MS : 30000,
      isVideo ? 5000 : 2000,
    );

    // Step 2: Publish the container
    return this.publishContainer(
      tokens,
      igUserId,
      containerId,
      payload.content,
      isStory
        ? { mediaKind: isVideo ? "VIDEO" : "IMAGE", channelUsername: payload.metadata?.channelUsername }
        : null
    );
  }
```

- [ ] **Step 4: Implement — createMediaContainer accepts unknown values**

Change the signature at line ~682 from `params: Record<string, string>` to `params: Record<string, unknown>`. The body (`JSON.stringify({ ...params, access_token })`) is unchanged, so every existing request serialises identically.

- [ ] **Step 5: Implement — publishContainer story options + story URL**

Change the `publishContainer` signature (line ~709) to:

```ts
  /**
   * Publish a media container.
   *
   * `caption` is passed for RECONCILIATION ONLY — it is never re-sent to Meta. It
   * is how a post Instagram already created is recognised on the account when the
   * publish call's own response is lost.
   *
   * `story` (2026-09-15): when set, reconciliation reads GET /{ig-user}/stories
   * instead of /media (which never lists stories) and the returned URL uses the
   * /stories/ shape. null ⇒ byte-identical to the pre-story behaviour.
   */
  private async publishContainer(
    tokens: OAuthTokens,
    igUserId: string,
    containerId: string,
    caption: string,
    story: { mediaKind: StoryMediaKind; channelUsername?: unknown } | null = null
  ): Promise<SocialPostResult> {
```

Inside the attempt loop, the two reconciliation calls become story-aware. Replace:

```ts
        return this.resolveUnknownPublish(tokens, igUserId, caption, windowStart, netErr);
```
with
```ts
        return this.resolveUnknownPublish(tokens, igUserId, caption, windowStart, netErr, story);
```
(and the same for the `parseErr` and the two `failure` calls — four call sites in total.)

Replace the quick check:
```ts
          const quick = await this.findPublishedMatch(tokens, igUserId, caption, windowStart, true).catch(() => null);
```
with
```ts
          const quick = await (story
            ? this.findPublishedStory(tokens, igUserId, windowStart, story.mediaKind)
            : this.findPublishedMatch(tokens, igUserId, caption, windowStart, true)
          ).catch(() => null);
```

Replace the URL block at the end of `publishContainer`:
```ts
    // media_publish returns a numeric media ID, not a shortcode.
    // Fetch the permalink field to get the real post URL.
    let url = `https://www.instagram.com/p/${data.id}`;
```
with
```ts
    // media_publish returns a numeric media ID, not a shortcode.
    // Fetch the permalink field to get the real post URL. For a story the /p/
    // shape is a 404, so the fallback is the account's /stories/ path.
    let url = story
      ? storyPermalinkFallback(story.channelUsername, String(data.id))
      : `https://www.instagram.com/p/${data.id}`;
```
(the permalink `try` block that follows is unchanged — a returned permalink still wins.)

- [ ] **Step 6: Implement — resolveUnknownPublish and findPublishedStory**

Change `resolveUnknownPublish`'s signature to add the trailing parameter and route the lookup:

```ts
  private async resolveUnknownPublish(
    tokens: OAuthTokens,
    igUserId: string,
    caption: string,
    since: Date,
    cause: unknown,
    story: { mediaKind: StoryMediaKind; channelUsername?: unknown } | null = null
  ): Promise<SocialPostResult> {
    // Let Instagram index before asking.
    if (RECONCILE_SETTLE_MS > 0) {
      await new Promise((r) => setTimeout(r, RECONCILE_SETTLE_MS));
    }

    const match = await (story
      ? this.findPublishedStory(tokens, igUserId, since, story.mediaKind)
      : this.findPublishedMatch(tokens, igUserId, caption, since, true)
    ).catch((e) => {
      console.warn(`[Instagram] reconciliation read failed for ${igUserId}: ${(e as Error)?.message}`);
      return null;
    });
```
(the rest of the method — adopt-or-throw `AmbiguousPublishError` — is unchanged.)

Add the new method directly after `findPublishedMatch`:

```ts
  /**
   * Story counterpart of findPublishedMatch. Stories never appear on /media, and
   * they carry no caption to match on, so the question becomes: "is there exactly
   * ONE live story of the kind we sent, created since `since`?"
   *
   * Three outcomes, kept distinct exactly like findPublishedMatch:
   *   result — exactly one candidate (adopt it);
   *   null   — the listing was readable and holds no candidate;
   *   throw  — cannot tell (Graph error, or SEVERAL candidates: adopting one of
   *            them would record someone else's story as ours).
   */
  private async findPublishedStory(
    tokens: OAuthTokens,
    igUserId: string,
    since: Date,
    kind: StoryMediaKind
  ): Promise<SocialPostResult | null> {
    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/stories` +
        `?fields=id,timestamp,media_type,permalink&access_token=${tokens.accessToken}`
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Instagram stories listing unavailable (${JSON.stringify(data?.error ?? data).slice(0, 200)}) — cannot confirm whether the story published`
      );
    }
    const picked = pickStoryCandidate(Array.isArray(data?.data) ? data.data : [], since, kind);
    if (picked.outcome === "match") {
      return {
        platformPostId: picked.story.id,
        url: picked.story.permalink ?? storyPermalinkFallback(undefined, picked.story.id),
      };
    }
    if (picked.outcome === "many") {
      throw new Error(
        `Instagram lists ${picked.count} stories created in the reconciliation window — cannot tell which (if any) is ours`
      );
    }
    return null;
  }
```

- [ ] **Step 7: Implement — pre-flight returns null for stories**

Replace the body of `findExistingPost`:

```ts
  async findExistingPost(
    tokens: OAuthTokens,
    payload: SocialPostPayload,
    since: Date
  ): Promise<SocialPostResult | null> {
    // Stories: never adopt here. /media does not list stories, and a same-caption
    // FEED post must not be mistaken for one; /stories cannot be used either
    // because the pre-flight window starts at post.createdAt — for a scheduled
    // post that spans days of the account's own manual stories. Publishing is the
    // pre-fix risk level (documented empty-caption limitation); the post-write
    // path (findPublishedStory) still catches a lost acknowledgement.
    if (isStoryFormat(payload.metadata)) return null;
    const igUserId =
      (payload.metadata?.igUserId as string) || (await this.getInstagramBusinessAccountId(tokens));
    // PRE-write: an empty listing means "not published", so publishing must proceed.
    return this.findPublishedMatch(tokens, igUserId, payload.content, since, false);
  }
```

- [ ] **Step 8: Run the new tests AND the existing IG suites**

Run: `npx vitest run instagram-story-publish instagram-publish-ambiguity video-thumbnail instagram-connect-errors instagram-analytics instagram-insights-metrics`
Expected: all PASS. If `instagram-publish-ambiguity` fails, a non-story path changed — fix the regression, do not edit that suite.

- [ ] **Step 9: Type-check the package**

Run: `pnpm --filter @postautomation/social exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/social/src/providers/instagram.provider.ts packages/social/src/__tests__/instagram-story-publish.test.ts
git commit -m "feat(social): Instagram image stories, user_tags mentions, story-aware duplicate reconciliation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Worker — story analytics helpers, at-age windows, no AI image, channelUsername

**Files:**
- Create: `apps/worker/src/lib/story-analytics.ts`
- Test: `apps/worker/src/__tests__/story-analytics.test.ts`
- Modify: `apps/worker/src/workers/post-publish.worker.ts` (~L541-548, ~L608-610, ~L1006-1030)
- Modify: `apps/worker/src/scheduler/cron-jobs.ts` (scheduleAnalyticsSync ~L289-298, scheduleLongTailAnalyticsSync ~L348-357, reconcileAtAgeCheckpoints ~L580-632)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/worker/src/__tests__/story-analytics.test.ts
import { describe, it, expect } from "vitest";
import {
  STORY_LIFETIME_MS,
  atAgeWindowsForFormat,
  checkpointTagsForFormat,
  excludeExpiredStoriesWhere,
} from "../lib/story-analytics";

describe("atAgeWindowsForFormat", () => {
  it("keeps all four checkpoints for every non-story format (byte-identical)", () => {
    for (const f of [null, undefined, "FEED", "REEL", "SHORT", "VIDEO", "CAROUSEL"]) {
      expect(atAgeWindowsForFormat(f), String(f)).toEqual([
        ["24h", 86_400_000],
        ["7d", 604_800_000],
        ["15d", 1_296_000_000],
        ["30d", 2_592_000_000],
      ]);
    }
  });
  it("a STORY only gets the 24h checkpoint — it no longer exists after that", () => {
    expect(atAgeWindowsForFormat("STORY")).toEqual([["24h", 86_400_000]]);
    expect(checkpointTagsForFormat("STORY")).toEqual(["24h"]);
    expect(checkpointTagsForFormat("REEL")).toEqual(["24h", "7d", "15d", "30d"]);
  });
});

describe("excludeExpiredStoriesWhere", () => {
  it("excludes STORY targets published more than 24h before now, nothing else", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    expect(excludeExpiredStoriesWhere(now)).toEqual({
      NOT: { format: "STORY", publishedAt: { lt: new Date(now.getTime() - STORY_LIFETIME_MS) } },
    });
    expect(STORY_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run story-analytics`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper module**

```ts
// apps/worker/src/lib/story-analytics.ts
/**
 * Analytics scheduling rules for Instagram STORIES (2026-09-15).
 *
 * A story disappears 24h after publish, so every metric read after that is
 * wasted quota at best and a fabricated failure at worst. These helpers keep
 * the rule in ONE place for the publish worker (at-age enqueue) and the cron
 * scheduler (recurring passes + checkpoint reconciliation), so the two cannot
 * drift. Every non-story format returns the pre-feature values.
 */

export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The four at-age checkpoints, in enqueue order (windowTag → delay ms). */
export const AT_AGE_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ["24h", 86_400_000],
  ["7d", 604_800_000],
  ["15d", 1_296_000_000],
  ["30d", 2_592_000_000],
];

export function atAgeWindowsForFormat(format: string | null | undefined): Array<[string, number]> {
  const all = AT_AGE_WINDOWS.map(([tag, ms]) => [tag, ms] as [string, number]);
  return String(format ?? "").toUpperCase() === "STORY" ? all.filter(([tag]) => tag === "24h") : all;
}

export function checkpointTagsForFormat(format: string | null | undefined): string[] {
  return atAgeWindowsForFormat(format).map(([tag]) => tag);
}

/**
 * Prisma `where` fragment: skip STORY targets whose story has already expired.
 * Spread into the recurring analytics passes' target selection.
 */
export function excludeExpiredStoriesWhere(now: Date): { NOT: { format: "STORY"; publishedAt: { lt: Date } } } {
  return { NOT: { format: "STORY", publishedAt: { lt: new Date(now.getTime() - STORY_LIFETIME_MS) } } };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run story-analytics` → PASS.

- [ ] **Step 5: Wire the publish worker**

In `post-publish.worker.ts`, add the import near the other `../lib/...` imports:
```ts
import { atAgeWindowsForFormat } from "../lib/story-analytics";
```

(a) providerMetadata (~L543-548) — add ONE conditional key, gated on the format so non-story metadata is unchanged:
```ts
      const providerMetadata: Record<string, unknown> = {
        ...((postTarget.post.metadata as object) || {}),
        ...((postTarget.metadata as object) || {}),
        ...(postTarget.format ? { format: postTarget.format } : {}),
        // Stories only: the provider builds the /stories/{username}/{id}/ URL when
        // Meta returns no permalink. Gated on the format so every non-story
        // provider payload is byte-identical.
        ...(postTarget.format === "STORY" && channel.username ? { channelUsername: channel.username } : {}),
        ...channelMetadata, // pageId/igUserId/logo_path MUST win — kept last
      };
```

(b) AI auto-image (~L609) — a story must be the user's media:
```ts
      // Auto-generate AI image for media-required platforms (Instagram, Facebook) if no media attached.
      // Never for a STORY: the user asked to publish THEIR image/video; a media-less
      // story fails validation below with a clear message instead.
      const mediaRequiredPlatforms = ["INSTAGRAM", "FACEBOOK"];
      if (mediaUrls.length === 0 && mediaRequiredPlatforms.includes(platform) && postTarget.format !== "STORY") {
```

(c) at-age enqueue (~L1007-1013) — replace the literal map + loop header:
```ts
      if (result.platformPostId) {
        // STORY targets get only the 24h checkpoint (the story is gone after that).
        for (const [windowTag, delay] of atAgeWindowsForFormat(postTarget.format)) {
```
and delete the local `AT_AGE_WINDOWS` const. Verify `postTarget.format` is selected in the worker's target query (grep `postTarget = await prisma.postTarget.find` — it is a full-row `include`, so `format` is present; if it were a `select`, add `format: true`).

- [ ] **Step 6: Wire the cron**

In `cron-jobs.ts` add the import next to the other `../lib/...` imports:
```ts
import { excludeExpiredStoriesWhere, checkpointTagsForFormat } from "../lib/story-analytics";
```

`scheduleAnalyticsSync` where (~L290):
```ts
    where: {
      status: "PUBLISHED",
      publishedId: { not: null },
      publishedAt: { gte: sevenDaysAgo },
      // Instagram STORIES expire after 24h — stop refreshing them after that.
      ...excludeExpiredStoriesWhere(new Date()),
      channel: {
        isActive: true,
        platform: { not: "FACEBOOK" }, // FB excluded — restores quota
      },
    },
```
`scheduleLongTailAnalyticsSync` where (~L349): add the same `...excludeExpiredStoriesWhere(new Date(now)),` line after `publishedAt` (every story in a 7–90d window is expired, so this excludes them all).

`reconcileAtAgeCheckpoints` (~L587 select + ~L612 loop): add `format: true,` to the `select`, and change the inner loop header to skip tags a story never schedules:
```ts
    const allowedTags = new Set(checkpointTagsForFormat(target.format));
    for (const [windowTag, windowMs] of Object.entries(AT_AGE_CHECKPOINTS)) {
      if (!allowedTags.has(windowTag)) continue; // a STORY has only the 24h checkpoint
      if (age <= windowMs + CHECKPOINT_GRACE_MS) continue; // checkpoint not yet due (by >grace)
```
(`const allowedTags` goes inside the `for (const target of targets)` loop, before the inner loop.)

- [ ] **Step 7: Run worker tests + type-check**

Run: `pnpm --filter @postautomation/worker test` and `pnpm --filter @postautomation/worker exec tsc --noEmit`
Expected: all green (the watchdog/at-age/external-sync suites unchanged).

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/lib/story-analytics.ts apps/worker/src/__tests__/story-analytics.test.ts apps/worker/src/workers/post-publish.worker.ts apps/worker/src/scheduler/cron-jobs.ts
git commit -m "feat(worker): bound Instagram story analytics to 24h; no AI auto-image for stories; story URL username

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: API story validation lib

**Files:**
- Create: `packages/api/src/lib/instagram-story.ts`
- Test: `packages/api/src/__tests__/instagram-story-create.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/api/src/__tests__/instagram-story-create.test.ts
import { describe, it, expect } from "vitest";
import { normalizeStoryMentions, validateStoryPost, storyInputSchema, STORY_MAX_MENTIONS } from "../lib/instagram-story";

describe("normalizeStoryMentions", () => {
  it("strips @, trims, dedupes case-insensitively, keeps order", () => {
    expect(normalizeStoryMentions([" @NatGeo ", "natgeo", "nasa"])).toEqual({ mentions: ["NatGeo", "nasa"], invalid: [] });
  });
  it("names every invalid username instead of silently dropping it", () => {
    expect(normalizeStoryMentions(["ok", "not ok", "bad-dash", "a".repeat(31)])).toEqual({
      mentions: ["ok"],
      invalid: ["not ok", "bad-dash", "a".repeat(31)],
    });
  });
  it("rejects more than STORY_MAX_MENTIONS", () => {
    const many = Array.from({ length: STORY_MAX_MENTIONS + 1 }, (_, i) => `u${i}`);
    expect(normalizeStoryMentions(many).mentions).toHaveLength(STORY_MAX_MENTIONS);
    expect(normalizeStoryMentions(many).invalid).toEqual([`u${STORY_MAX_MENTIONS}`]);
  });
});

describe("validateStoryPost", () => {
  const ig = (id: string) => ({ id, platform: "INSTAGRAM", name: `ig-${id}` });
  it("accepts one media to Instagram channels", () => {
    expect(validateStoryPost({ channels: [ig("a"), ig("b")], mediaCount: 1, scheduling: true })).toBeNull();
  });
  it("rejects any non-Instagram channel by name", () => {
    const err = validateStoryPost({ channels: [ig("a"), { id: "f", platform: "FACEBOOK", name: "My Page" }], mediaCount: 1, scheduling: true });
    expect(err).toMatch(/Instagram/);
    expect(err).toContain("My Page");
  });
  it("requires exactly one media when scheduling/publishing, allows a media-less DRAFT", () => {
    expect(validateStoryPost({ channels: [ig("a")], mediaCount: 0, scheduling: true })).toMatch(/one image or video/);
    expect(validateStoryPost({ channels: [ig("a")], mediaCount: 2, scheduling: true })).toMatch(/exactly one/);
    expect(validateStoryPost({ channels: [ig("a")], mediaCount: 2, scheduling: false })).toMatch(/exactly one/);
    expect(validateStoryPost({ channels: [ig("a")], mediaCount: 0, scheduling: false })).toBeNull();
  });
  it("a channel-less story draft is fine", () => {
    expect(validateStoryPost({ channels: [], mediaCount: 1, scheduling: false })).toBeNull();
  });
});

describe("storyInputSchema", () => {
  it("defaults mentions to [] and bounds the raw input", () => {
    expect(storyInputSchema.parse({})).toEqual({ mentions: [] });
    expect(storyInputSchema.safeParse({ mentions: Array.from({ length: 51 }, () => "u") }).success).toBe(false);
    expect(storyInputSchema.safeParse({ mentions: ["x".repeat(65)] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run instagram-story-create` → module not found.

- [ ] **Step 3: Implement**

```ts
// packages/api/src/lib/instagram-story.ts
import { z } from "zod";

/**
 * Server-side rules for a Story post (post.create / post.update).
 *
 * ⚠️ This is an intentional REPLICA of the username rule in
 * packages/social/src/utils/instagram-story.ts (the web client carries a third
 * copy in apps/web/lib/instagram-story.ts). The api package must not import the
 * social provider bundle for one regex, and the provider re-validates what comes
 * out of the DB anyway. Keep the three in step.
 */
export const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
export const STORY_MAX_MENTIONS = 20;

/** Raw client input: bounded so a hostile payload cannot be large. */
export const storyInputSchema = z.object({
  mentions: z.array(z.string().max(64)).max(50).default([]),
});
export type StoryInput = z.infer<typeof storyInputSchema>;

export function normalizeStoryMentions(raw: string[]): { mentions: string[]; invalid: string[] } {
  const mentions: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const username = item.trim().replace(/^@/, "");
    if (!username) continue;
    if (!IG_USERNAME_RE.test(username)) { invalid.push(item.trim()); continue; }
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    if (mentions.length >= STORY_MAX_MENTIONS) { invalid.push(item.trim()); continue; }
    seen.add(key);
    mentions.push(username);
  }
  return { mentions, invalid };
}

/**
 * Returns an actionable error message, or null when the story post is valid.
 * `scheduling` = the post will publish (scheduledAt set); drafts may be
 * media-less so the user can attach later, but never carry 2+ media.
 */
export function validateStoryPost(input: {
  channels: Array<{ id: string; platform: string; name?: string | null }>;
  mediaCount: number;
  scheduling: boolean;
}): string | null {
  const foreign = input.channels.filter((c) => c.platform !== "INSTAGRAM");
  if (foreign.length > 0) {
    const names = foreign.map((c) => c.name || c.id).join(", ");
    return `Stories can only be published to Instagram channels. Remove: ${names}.`;
  }
  if (input.mediaCount > 1) {
    return `A story takes exactly one image or video — this post has ${input.mediaCount} attachments. Remove the extras, or switch to a normal post.`;
  }
  if (input.scheduling && input.mediaCount === 0) {
    return "Attach one image or video to publish a story.";
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run instagram-story-create` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/instagram-story.ts packages/api/src/__tests__/instagram-story-create.test.ts
git commit -m "feat(api): story post validation helpers (mentions, IG-only, single media)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: post.router — story input on create, story-safe update

**Files:**
- Modify: `packages/api/src/routers/post.router.ts` (create input L105-151, body L152-381; update L479-571)

- [ ] **Step 1: Imports**

Next to the `planSuperText` import (line 6) add:
```ts
import { storyInputSchema, normalizeStoryMentions, validateStoryPost } from "../lib/instagram-story";
```

- [ ] **Step 2: Input schema**

Change `content: z.string().min(1),` (L108) to:
```ts
        // min(1) is enforced below for normal posts. A STORY carries no visible
        // caption, so its note may be empty.
        content: z.string(),
```
After the `formatByChannelId` line (L131) add:
```ts
        // Story mode (2026-09-15): presence of `story` makes this an Instagram
        // Story post — every target gets format STORY, channels must be
        // Instagram, exactly one media when publishing, mentions → user_tags.
        story: storyInputSchema.optional(),
```

- [ ] **Step 3: Story checks at the top of the mutation**

Directly after `await enforcePlanLimit(...)` (L154) insert:
```ts
      const isStory = !!input.story;
      if (!isStory && input.content.trim().length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Content is required." });
      }
      let storyMentions: string[] = [];
      if (input.story) {
        const norm = normalizeStoryMentions(input.story.mentions);
        if (norm.invalid.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `These aren't valid Instagram usernames: ${norm.invalid.join(", ")}. Use letters, numbers, dots or underscores (max 30), up to 20 people.`,
          });
        }
        storyMentions = norm.mentions;
      }
```

- [ ] **Step 4: Channel platform check**

Change the owned-channel select (L176) to `select: { id: true, platform: true, name: true },` and, right after the ownership `if` block ends (after L191), insert:
```ts
      if (isStory) {
        const storyError = validateStoryPost({
          channels: ownedChannels,
          mediaCount: input.mediaIds?.length ?? 0,
          scheduling: !!input.scheduledAt,
        });
        if (storyError) throw new TRPCError({ code: "BAD_REQUEST", message: storyError });
      }
```

- [ ] **Step 5: Neutralise post-only features in story mode**

`planCaptionFanout` (L232-236): `uniqueCaptions: isStory ? false : input.uniqueCaptions,`.

Thumbnail (L278): `const thumbMediaId = isStory ? undefined : ((input.metadata as any)?.videoThumbnail?.mediaId as string | undefined);` (covers are reels-only; the provider gate already refuses them, this keeps the DB clean).

- [ ] **Step 6: Persist**

In the metadata IIFE (L329-354), add `instagramStory: _rawStory,` to the destructure (so a client cannot smuggle its own value through the passthrough), and after `if (videoThumbnail) out.videoThumbnail = videoThumbnail;` add:
```ts
            if (isStory) out.instagramStory = { mentions: storyMentions };
```
Targets (L356-360):
```ts
            create: input.channelIds.map((channelId) => ({
              channelId,
              status,
              // Story mode forces STORY on every target; otherwise the per-channel
              // picker value (or null) exactly as before.
              format: (isStory ? "STORY" : (input.formatByChannelId?.[channelId] ?? null)) as any,
            })),
```

- [ ] **Step 7: post.update keeps a story a story**

In `update` (L498-504) the `findFirst` already returns scalar `metadata`. After `if (!existing) throw …` (L505) add:
```ts
      const isStoryPost = !!(existing.metadata as { instagramStory?: unknown } | null)?.instagramStory;
```
In the `channelIds` block (L520-526), change the select to `select: { id: true, platform: true, name: true },` and after the ownership `if` add:
```ts
        if (isStoryPost) {
          const storyError = validateStoryPost({
            channels: ownedChannels,
            mediaCount: existing._count.mediaAttachments,
            scheduling: !!(input.scheduledAt !== undefined ? input.scheduledAt : existing.scheduledAt),
          });
          if (storyError) throw new TRPCError({ code: "BAD_REQUEST", message: storyError });
        }
```
Targets create (L559-562):
```ts
              create: channelIds.map((channelId) => ({
                channelId,
                status: existing.status,
                ...(isStoryPost ? { format: "STORY" as const } : {}),
              })),
```

- [ ] **Step 8: Run api tests + type-check**

Run: `pnpm --filter @postautomation/api test` then `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: green. Watch `post-archive`, `publish-now-ambiguity`, `bulk-schedule-targets`, `video-thumbnail-post-create`, `super-text-plan`, `chat-action-*` in particular — none assert `content.min(1)` via the schema, but if one does, it will now see the manual `BAD_REQUEST` instead (same code, friendlier message); update the assertion text only if necessary.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/routers/post.router.ts
git commit -m "feat(api): post.create story mode (IG-only, single media, mentions → metadata.instagramStory, format STORY)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Web pure helpers

**Files:**
- Create: `apps/web/lib/instagram-story.ts`
- Test: `apps/web/lib/instagram-story.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/lib/instagram-story.test.ts
import { describe, it, expect } from "vitest";
import {
  isInstagramChannel,
  storySelectableChannels,
  pruneSelectionForStory,
  groupSelectableIds,
  addMentions,
  storyBlockReason,
  STORY_MAX_MENTIONS,
} from "./instagram-story";

const ch = (id: string, platform: string, isActive = true) => ({ id, platform, isActive });

describe("storySelectableChannels / pruneSelectionForStory", () => {
  const channels = [ch("ig1", "INSTAGRAM"), ch("fb1", "FACEBOOK"), ch("ig2", "INSTAGRAM"), ch("yt", "YOUTUBE")];
  it("post mode returns every channel untouched; story mode only Instagram", () => {
    expect(storySelectableChannels(channels, "post")).toEqual(channels);
    expect(storySelectableChannels(channels, "story").map((c) => c.id)).toEqual(["ig1", "ig2"]);
    expect(storySelectableChannels(undefined, "story")).toEqual([]);
    expect(isInstagramChannel(ch("x", "INSTAGRAM"))).toBe(true);
  });
  it("prunes non-Instagram ids and reports how many were removed", () => {
    expect(pruneSelectionForStory(["ig1", "fb1", "yt", "ghost"], channels)).toEqual({ next: ["ig1"], removed: 3 });
    expect(pruneSelectionForStory(["ig1", "ig2"], channels)).toEqual({ next: ["ig1", "ig2"], removed: 0 });
  });
});

describe("groupSelectableIds", () => {
  const live = new Set(["ig1", "fb1", "ig2"]);
  const group = { channels: [ch("ig1", "INSTAGRAM"), ch("fb1", "FACEBOOK"), ch("ig2", "INSTAGRAM", false), ch("gone", "INSTAGRAM")] };
  it("post mode: active + live members of any platform (today's rule)", () => {
    expect(groupSelectableIds(group, live, "post")).toEqual(["ig1", "fb1"]);
  });
  it("story mode: only active + live INSTAGRAM members", () => {
    expect(groupSelectableIds(group, live, "story")).toEqual(["ig1"]);
    expect(groupSelectableIds({ channels: [ch("fb1", "FACEBOOK")] }, live, "story")).toEqual([]);
    expect(groupSelectableIds({}, live, "story")).toEqual([]);
  });
});

describe("addMentions", () => {
  it("splits on commas/whitespace, strips @, dedupes against existing, names invalid", () => {
    expect(addMentions(["natgeo"], "@nasa, NATGEO spacex bad-name")).toEqual({
      mentions: ["natgeo", "nasa", "spacex"],
      invalid: ["bad-name"],
      dropped: 0,
    });
  });
  it("caps at STORY_MAX_MENTIONS and counts the overflow", () => {
    const existing = Array.from({ length: STORY_MAX_MENTIONS - 1 }, (_, i) => `u${i}`);
    const r = addMentions(existing, "a b c");
    expect(r.mentions).toHaveLength(STORY_MAX_MENTIONS);
    expect(r.dropped).toBe(2);
  });
  it("empty input is a no-op", () => {
    expect(addMentions(["x"], "   ")).toEqual({ mentions: ["x"], invalid: [], dropped: 0 });
  });
});

describe("storyBlockReason", () => {
  it("needs exactly one media and at least one channel", () => {
    expect(storyBlockReason({ mediaCount: 0, selectedCount: 1, uploading: false })).toMatch(/one image or video/);
    expect(storyBlockReason({ mediaCount: 2, selectedCount: 1, uploading: false })).toMatch(/exactly one/);
    expect(storyBlockReason({ mediaCount: 1, selectedCount: 0, uploading: false })).toMatch(/Instagram channel/);
    expect(storyBlockReason({ mediaCount: 1, selectedCount: 1, uploading: true })).toMatch(/uploading/);
    expect(storyBlockReason({ mediaCount: 1, selectedCount: 1, uploading: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/web/lib/instagram-story` → module not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/lib/instagram-story.ts
/**
 * Pure helpers for Compose's Instagram Story mode (2026-09-15). No React, no
 * tRPC — so the channel filtering, group behaviour and mention parsing are unit
 * tested and the component only wires them up.
 *
 * ⚠️ IG_USERNAME_RE is a deliberate replica of the rule in packages/api and
 * packages/social (the client must not import server bundles for one regex).
 * Keep the three in step.
 */

export type PostType = "post" | "story";

export const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
export const STORY_MAX_MENTIONS = 20;

export function isInstagramChannel(channel: { platform: string }): boolean {
  return channel.platform === "INSTAGRAM";
}

/** In story mode only Instagram channels are selectable; post mode is untouched. */
export function storySelectableChannels<T extends { platform: string }>(
  channels: T[] | undefined | null,
  postType: PostType
): T[] {
  const list = channels ?? [];
  return postType === "story" ? list.filter(isInstagramChannel) : list;
}

/** Drop every selected id that is not a (live) Instagram channel. */
export function pruneSelectionForStory(
  selectedIds: string[],
  channels: Array<{ id: string; platform: string }>
): { next: string[]; removed: number } {
  const igIds = new Set(channels.filter(isInstagramChannel).map((c) => c.id));
  const next = selectedIds.filter((id) => igIds.has(id));
  return { next, removed: selectedIds.length - next.length };
}

/**
 * The ids a Groups pill acts on. Post mode = today's rule (active + still in
 * the live channel list). Story mode additionally keeps only Instagram members,
 * so one click can never pull a Facebook Page into a story.
 */
export function groupSelectableIds(
  group: { channels?: Array<{ id: string; platform: string; isActive: boolean }> | null },
  liveIds: Set<string>,
  postType: PostType
): string[] {
  return (group.channels ?? [])
    .filter((c) => c.isActive && liveIds.has(c.id))
    .filter((c) => postType === "post" || isInstagramChannel(c))
    .map((c) => c.id);
}

/**
 * Merge freshly typed usernames into the existing list. Splits on commas and
 * whitespace, strips a leading @, dedupes case-insensitively against what is
 * already there, names invalid entries, and counts anything dropped by the cap.
 */
export function addMentions(
  existing: string[],
  raw: string
): { mentions: string[]; invalid: string[]; dropped: number } {
  const mentions = [...existing];
  const seen = new Set(existing.map((m) => m.toLowerCase()));
  const invalid: string[] = [];
  let dropped = 0;
  for (const token of raw.split(/[\s,]+/)) {
    const username = token.trim().replace(/^@/, "");
    if (!username) continue;
    if (!IG_USERNAME_RE.test(username)) { invalid.push(token.trim()); continue; }
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    if (mentions.length >= STORY_MAX_MENTIONS) { dropped++; continue; }
    seen.add(key);
    mentions.push(username);
  }
  return { mentions, invalid, dropped };
}

/** Why the story cannot be submitted right now, or null when it can. */
export function storyBlockReason(input: { mediaCount: number; selectedCount: number; uploading: boolean }): string | null {
  if (input.uploading) return "Media is still uploading.";
  if (input.mediaCount === 0) return "Attach one image or video for your story.";
  if (input.mediaCount > 1) return `A story takes exactly one image or video — remove ${input.mediaCount - 1} attachment${input.mediaCount - 1 === 1 ? "" : "s"}.`;
  if (input.selectedCount === 0) return "Select at least one Instagram channel.";
  return null;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run apps/web/lib/instagram-story` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/instagram-story.ts apps/web/lib/instagram-story.test.ts
git commit -m "feat(web): pure Instagram story helpers for Compose (channel/group filtering, mentions, block reason)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Draft type + InstagramStoryPreview component

**Files:**
- Modify: `apps/web/lib/active-task.tsx` (L12-23)
- Create: `apps/web/components/previews/instagram-story-preview.tsx`

- [ ] **Step 1: Extend the draft type** (additive — older persisted drafts simply lack the keys)

```ts
  draft?: {
    content?: string;
    channels?: string[];
    /** @deprecated kept for back-compat with persisted payloads — use `media` */
    mediaUrls?: string[];
    /**
     * Restorable attachments: items with a Media row id or a non-blob URL.
     * `superText` is the optional burned-strip config (kept as `unknown` so this
     * provider stays package-agnostic — ComposeTab re-validates it on restore).
     */
    media?: { url: string; mediaId?: string; superText?: unknown }[];
    /** Compose post type (2026-09-15). Absent ⇒ "post" — drafts from older builds restore unchanged. */
    postType?: "post" | "story";
    /** Story mentions (usernames without @). ComposeTab re-validates on restore. */
    storyMentions?: string[];
  };
```

- [ ] **Step 2: Create the preview component**

```tsx
// apps/web/components/previews/instagram-story-preview.tsx
"use client";

import { PreviewMedia, type MediaKind } from "./preview-media";
import { Avatar, AvatarImage, AvatarFallback } from "~/components/ui/avatar";

export interface InstagramStoryPreviewProps {
  mediaUrl?: string;
  mediaKind?: MediaKind;
  mentions: string[];
  /** Selected Instagram accounts — the first is shown in the header, the rest as "+N". */
  accounts: Array<{ name: string; username?: string | null; avatar?: string | null }>;
  note?: string;
}

function initials(name: string): string {
  return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "IG";
}

/**
 * 9:16 story frame. Media goes through PreviewMedia (the video/image safety
 * rules from CLAUDE.md hold — never a video URL in <img>). Mentions render as
 * the plain "@user" text Instagram shows for a sticker-less mention.
 */
export function InstagramStoryPreview({ mediaUrl, mediaKind, mentions, accounts, note }: InstagramStoryPreviewProps) {
  const first = accounts[0];
  const username = first?.username || first?.name?.toLowerCase().replace(/\s+/g, "") || "yourname";
  return (
    <div className="space-y-2">
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[300px] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-white shadow-lg">
        {/* progress bar */}
        <div className="absolute left-2 right-2 top-2 z-20 h-0.5 rounded-full bg-white/30">
          <div className="h-full w-1/3 rounded-full bg-white" />
        </div>
        {/* header */}
        <div className="absolute left-2 right-2 top-4 z-20 flex items-center gap-2">
          <Avatar className="h-7 w-7 border border-white/60">
            {first?.avatar ? <AvatarImage src={first.avatar} alt={username} /> : null}
            <AvatarFallback className="bg-zinc-700 text-[10px] text-white">{initials(first?.name ?? "")}</AvatarFallback>
          </Avatar>
          <span className="truncate text-xs font-semibold drop-shadow">{username}</span>
          <span className="text-[10px] text-white/70">now</span>
        </div>
        {/* media */}
        {mediaUrl ? (
          <PreviewMedia url={mediaUrl} kind={mediaKind} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-white/60">
            Add one image or video to preview your story
          </div>
        )}
        {/* mentions */}
        {mentions.length > 0 && (
          <div className="absolute bottom-10 left-3 right-3 z-20 flex flex-wrap gap-1.5">
            {mentions.map((m) => (
              <span key={m} className="rounded-md bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-zinc-900 shadow">
                @{m}
              </span>
            ))}
          </div>
        )}
        {/* reply bar */}
        <div className="absolute bottom-2 left-3 right-3 z-20 rounded-full border border-white/50 px-3 py-1.5 text-[11px] text-white/70">
          Send message
        </div>
      </div>
      <p className="text-center text-[10px] text-muted-foreground">
        {accounts.length > 1 ? `Publishes to ${accounts.length} Instagram accounts · ` : ""}
        Preview only · disappears 24h after publishing
      </p>
      {note ? <p className="text-center text-[10px] italic text-muted-foreground">Note (not shown on the story): {note.slice(0, 80)}</p> : null}
    </div>
  );
}
```

Export it from `apps/web/components/previews/index.ts` (add `export { InstagramStoryPreview } from "./instagram-story-preview";` next to the existing exports).

- [ ] **Step 3: Type-check web**

Run: `pnpm --filter @postautomation/web exec tsc --noEmit` → no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/active-task.tsx apps/web/components/previews/instagram-story-preview.tsx apps/web/components/previews/index.ts
git commit -m "feat(web): Instagram story preview component; draft type carries postType + mentions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: ComposeTab — Story mode

**Files:**
- Modify: `apps/web/components/content-agent/ComposeTab.tsx`

All edits below are additive; with `postType === "post"` every branch evaluates to today's JSX/logic.

- [ ] **Step 1: Imports**

After the `channel-platform-filter` import block add:
```ts
import {
  type PostType,
  storySelectableChannels,
  pruneSelectionForStory,
  groupSelectableIds,
  addMentions,
  storyBlockReason,
  STORY_MAX_MENTIONS,
} from "~/lib/instagram-story";
import { InstagramStoryPreview } from "~/components/previews/instagram-story-preview";
```

- [ ] **Step 2: State** — after the `ytMetadata` state (L190):
```ts
  // Instagram Story mode (2026-09-15). "story" publishes ONE image/video as a
  // STORY to Instagram channels only. Every branch below that reads
  // `isStoryMode` is the pre-feature code when it is false.
  const [postType, setPostType] = useState<PostType>("post");
  const isStoryMode = postType === "story";
  const [storyMentions, setStoryMentions] = useState<string[]>([]);
  const [storyMentionInput, setStoryMentionInput] = useState("");
  const [storyMentionError, setStoryMentionError] = useState<string | null>(null);
```

- [ ] **Step 3: Draft restore** — inside the restore effect, after the `setSelectedChannels(saved.draft.channels)` block (L250):
```ts
    if (saved.draft.postType === "story") setPostType("story");
    if (Array.isArray(saved.draft.storyMentions) && saved.draft.storyMentions.length > 0) {
      // Re-validate: never trust a persisted list (older build / hand-edited storage).
      setStoryMentions(addMentions([], saved.draft.storyMentions.filter((m) => typeof m === "string").join(" ")).mentions);
    }
```

- [ ] **Step 4: Draft persist** — extend the `addTask` draft (L340-354) with `postType, storyMentions,` and the effect deps with a STRING signature (not the array):
```ts
        draft: {
          content,
          channels: selectedChannels,
          postType,
          storyMentions,
          mediaUrls: postMedia.map((m) => m.url),
          ...
```
and change the deps line to:
```ts
  }, [content, selectedChannels, draftMediaSignature, postType, storyMentionsSignature]);
```
with, above the effect:
```ts
  const storyMentionsSignature = storyMentions.join(",");
```
Also widen the "has a draft" condition to `content.trim().length > 0 || selectedChannels.length > 0 || postMedia.length > 0 || storyMentions.length > 0`.

- [ ] **Step 5: Keep the selection Instagram-only while in story mode** — after the channel-reconcile effect (L414-421):
```ts
  // Story mode: a restored draft or a late-loading channel list may hold
  // non-Instagram ids — drop them (pure helper; a no-op returns `prev`).
  useEffect(() => {
    if (!isStoryMode || !channels) return;
    setSelectedChannels((prev) => {
      const { next, removed } = pruneSelectionForStory(prev, channels as any[]);
      return removed > 0 ? next : prev;
    });
  }, [isStoryMode, channels]);
```

- [ ] **Step 6: Mode switch handler + mention commit** — after `handleOpenEditor`:
```ts
  const switchPostType = (next: PostType) => {
    if (next === postType) return;
    setPostType(next);
    if (next === "story") {
      const { next: pruned, removed } = pruneSelectionForStory(selectedChannels, (channels as any[]) ?? []);
      if (removed > 0) {
        setSelectedChannels(pruned);
        toast({
          title: "Switched to Story",
          description: `${removed} non-Instagram channel${removed === 1 ? "" : "s"} removed — stories publish only to Instagram.`,
        });
      }
      setPlatformFilter(null);
      setUniqueCaptions(false);
    }
  };

  const commitMentionInput = () => {
    if (!storyMentionInput.trim()) return;
    const { mentions, invalid, dropped } = addMentions(storyMentions, storyMentionInput);
    setStoryMentions(mentions);
    setStoryMentionInput("");
    setStoryMentionError(
      invalid.length > 0
        ? `Not a valid Instagram username: ${invalid.join(", ")}`
        : dropped > 0
          ? `You can tag up to ${STORY_MAX_MENTIONS} people.`
          : null
    );
  };
```

- [ ] **Step 7: Submit + block reasons** — after `youtubeBlockReason` (L1194-1202) add:
```ts
  const storyBlock = isStoryMode
    ? storyBlockReason({ mediaCount: postMedia.length, selectedCount: selectedChannels.length, uploading: mediaBusy })
    : null;
```
In `handleSubmit` change the first guard to:
```ts
    if ((!isStoryMode && !content) || selectedChannels.length === 0) {
      toast({
        title: "Missing required fields",
        description: isStoryMode ? "Select at least one Instagram channel." : "Please add content and select at least one channel.",
        variant: "destructive",
      });
      return;
    }
    if (storyBlock) {
      toast({ title: "Story not ready", description: storyBlock, variant: "destructive" });
      return;
    }
```
And the `createPost.mutate({...})` call becomes:
```ts
      createPost.mutate({
        content,
        channelIds: selectedChannels,
        scheduledAt: publishNow
          ? new Date().toISOString()
          : scheduledAt
            ? new Date(scheduledAt).toISOString()
            : undefined,
        // PR-5: only sent on the schedule/publish path (draft-save keeps it off).
        // Never in story mode (stories have no caption).
        ...(!isStoryMode && uniqueCaptions && selectedChannels.length > 1 && { uniqueCaptions: true }),
        ...(mediaIds.length > 0 && { mediaIds }),
        // Story mode: the server forces format STORY on every target; the
        // per-channel picker values from Post mode must not leak in.
        ...(!isStoryMode && Object.keys(formatByChannelId).length > 0 && { formatByChannelId }),
        ...(isStoryMode && { story: { mentions: storyMentions } }),
        ...(() => {
          const cover = postMedia.find((m) => m.thumbnail)?.thumbnail;
          const md = isStoryMode
            ? { ...(Object.keys(superTextByMediaId).length > 0 ? { superText: superTextByMediaId } : {}) }
            : {
                ...ytMetadata,
                ...(Object.keys(superTextByMediaId).length > 0 ? { superText: superTextByMediaId } : {}),
                ...(cover ? { videoThumbnail: { mediaId: cover.mediaId } } : {}),
              };
          return Object.keys(md).length > 0 ? { metadata: md } : {};
        })(),
      });
```
(keep the existing explanatory comment about ONE cover per post above the non-story branch.)

Save-as-Draft `createPost.mutate` (L2100-2115): add `...(isStoryMode && { story: { mentions: storyMentions } }),` and use the same story/non-story `md` split (no `videoThumbnail` in story mode). Its `disabled` becomes `disabled={(isStoryMode ? postMedia.length === 0 && !content : !content) || createPost.isPending || isUploading}`.

Schedule button: `disabled={(!isStoryMode && !content) || selectedChannels.length === 0 || !scheduledAt || createPost.isPending || isUploading || !!youtubeBlockReason || !!storyBlock}`, `title={youtubeBlockReason ?? storyBlock ?? undefined}`, label `{isStoryMode ? "Schedule story" : "Schedule"}`.
Publish button: same disabled/title pattern, label `{isStoryMode ? "Publish story" : "Publish Now"}` (keep whatever the current label text is for post mode).

`createPost.onSuccess`: add `setStoryMentions([]); setStoryMentionInput(""); setStoryMentionError(null);` next to the existing resets.

- [ ] **Step 8: Mode switch UI** — as the FIRST child inside the `<>` fragment at L1219 (before the "Create with AI" card):
```tsx
          {/* Post type — Story publishes ONE image/video to Instagram Stories. */}
          <div className="flex flex-wrap items-center gap-3">
            <div role="tablist" aria-label="Post type" className="inline-flex rounded-lg border bg-muted/40 p-1">
              {(["post", "story"] as PostType[]).map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={postType === t}
                  onClick={() => switchPostType(t)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    postType === t ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "story" && <PlatformIcon platform="INSTAGRAM" size="sm" />}
                  {t === "post" ? "Post" : "Story"}
                </button>
              ))}
            </div>
            {isStoryMode && (
              <p className="text-xs text-muted-foreground">
                Instagram Story · one image or video · disappears after 24 hours · Instagram channels only
              </p>
            )}
          </div>
```

- [ ] **Step 9: Hide / relabel cards in story mode**
- Wrap the "Create with AI" `<Card>` (L1225-1272) in `{!isStoryMode && ( … )}`.
- Content card: title `{isStoryMode ? "Note (optional)" : "Content"}`; hide the "Enhance with AI" button in story mode (`{!isStoryMode && (<Button …>)}`); textarea `placeholder={isStoryMode ? "Optional note — stories don't display a caption; this is kept with the post for your records." : "Write your post here, or use 'Create with AI' above to generate content..."}` and `className={isStoryMode ? "min-h-[90px] resize-none" : "min-h-[200px] resize-none"}`.
- Wrap `<ImageGenerationPanel …/>` in `{!isStoryMode && ( … )}` — AI image generation stays a Post-mode tool (a story is the user's own media, matching the worker rule).
- Media card description: `{isStoryMode ? "One image or video · 9:16 recommended · image ≤8MB JPEG, video 3–60s ≤100MB" : hasYouTube ? … : …}`; add under the buttons row:
```tsx
              {isStoryMode && postMedia.length > 1 && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>A story takes exactly one image or video. Remove {postMedia.length - 1} attachment{postMedia.length - 1 === 1 ? "" : "s"}, or switch back to Post.</span>
                </div>
              )}
```
- Generate Carousel condition: `{!hasYouTube && !hasVideoAttached && !isStoryMode && (`.
- Thumbnail control on video tiles: `{isVideo && !isStoryMode && (<label …>)}` (covers are reels-only).
- Post Format card condition: `{!isStoryMode && ((hasYouTube && hasVideoAttached) || (hasInstagram && hasVideoAttached)) ? (`.
- Captions (unique per channel) card: `{!isStoryMode && selectedChannels.length > 1 && (`.

- [ ] **Step 10: Channel picker in story mode**
- Card description: `{isStoryMode ? "Stories publish only to Instagram accounts" : "Search and pick channels to publish to"}`.
- Groups: replace the `activeIds` computation with the helper:
```tsx
                    const groupsWithActive = ((channelGroups as any[]) ?? [])
                      .map((group: any) => ({ ...group, activeIds: groupSelectableIds(group, liveIds, postType) }))
                      .filter((group: any) => group.activeIds.length > 0);
```
(the pill's aria-label/count/click logic already reads `group.activeIds`, so groups with no Instagram members vanish and clicks only touch Instagram ids.)
- Platform pills: `if (isStoryMode || counts.length < 2) return null;`.
- List: replace `const platformScoped = filterByPlatform((channels as any[]) ?? [], platformFilter);` with
```tsx
                    const modeScoped = storySelectableChannels((channels as any[]) ?? [], postType);
                    const platformScoped = filterByPlatform(modeScoped, isStoryMode ? null : platformFilter);
```
- Empty state: in the `sorted.length === 0` branch, message `{isStoryMode ? "No Instagram channels connected — connect one on the Channels page" : "No channels found"}`.

- [ ] **Step 11: Tag people card** — insert after the Media `</Card>` (before the channel selection card):
```tsx
          {isStoryMode && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Tag people</CardTitle>
                <CardDescription>
                  Mention Instagram accounts on this story. They must be public; Instagram notifies them. Added as mentions (no sticker).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {storyMentions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {storyMentions.map((u) => (
                      <span key={u} className="inline-flex items-center gap-1 rounded-full border bg-primary/5 px-2.5 py-1 text-xs font-medium">
                        @{u}
                        <button
                          type="button"
                          aria-label={`Remove @${u}`}
                          onClick={() => setStoryMentions((prev) => prev.filter((x) => x !== u))}
                          className="ml-0.5 rounded-full p-0.5 hover:bg-destructive/10"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <Input
                  value={storyMentionInput}
                  onChange={(e) => { setStoryMentionInput(e.target.value); if (storyMentionError) setStoryMentionError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "," || e.key === " ") { e.preventDefault(); commitMentionInput(); }
                  }}
                  onBlur={commitMentionInput}
                  placeholder={storyMentions.length >= STORY_MAX_MENTIONS ? `Up to ${STORY_MAX_MENTIONS} people` : "@username — press Enter to add"}
                  disabled={storyMentions.length >= STORY_MAX_MENTIONS}
                  aria-label="Instagram username to tag"
                  className="h-9 text-sm"
                />
                <div className="flex items-center justify-between text-[11px]">
                  {storyMentionError ? <span className="text-destructive">{storyMentionError}</span> : <span />}
                  <span className="tabular-nums text-muted-foreground">{storyMentions.length}/{STORY_MAX_MENTIONS}</span>
                </div>
              </CardContent>
            </Card>
          )}
```

- [ ] **Step 12: Preview** — replace the `<PostPreviewSwitcher …/>` block with:
```tsx
          {isStoryMode ? (
            <InstagramStoryPreview
              mediaUrl={postMedia[0]?.url}
              mediaKind={postMedia[0] ? (isVideoMediaItem(postMedia[0]) ? "video" : "image") : undefined}
              mentions={storyMentions}
              accounts={((channels as any[]) ?? [])
                .filter((c: any) => selectedChannels.includes(c.id))
                .map((c: any) => ({ name: c.name, username: c.username, avatar: c.avatar }))}
              note={content}
            />
          ) : (
            <PostPreviewSwitcher … unchanged … />
          )}
```
and the header title `{isStoryMode ? "Story Preview" : "Post Preview"}`; the "Start typing and select channels" hint condition becomes `!isStoryMode && !content && selectedPlatforms.length === 0`.

- [ ] **Step 13: Verify**

Run: `pnpm --filter @postautomation/web exec tsc --noEmit` and `npx vitest run apps/web/lib` → green.
Run: `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` → succeeds.

- [ ] **Step 14: Commit**

```bash
git add apps/web/components/content-agent/ComposeTab.tsx
git commit -m "feat(compose): Instagram Story mode — Post|Story switch, IG-only channels/groups, tag people, story preview, story-aware submit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: "Story" badge on post detail + posts list

**Files:**
- Modify: `apps/web/app/dashboard/posts/[id]/page.tsx` (~L503-505)
- Modify: `apps/web/components/content-agent/PostsTab.tsx` (~L213-221)

- [ ] **Step 1: Post detail target row** — after the platform `<Badge>`:
```tsx
                        {target.format === "STORY" && (
                          <Badge variant="secondary" className="text-[10px]">Story</Badge>
                        )}
```

- [ ] **Step 2: Posts list row** — in the meta line, before the channel count:
```tsx
                    {post.targets.some((t: any) => t.format === "STORY") && (
                      <>
                        <span className="font-semibold text-foreground">Story</span>
                        <span className="px-1.5 text-faint">·</span>
                      </>
                    )}
```
Also, since a story's `content` may be empty, render `{post.content.slice(0, 100) || (post.targets.some((t: any) => t.format === "STORY") ? "Instagram story" : "(no text)")}` for the title line.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @postautomation/web exec tsc --noEmit
git add "apps/web/app/dashboard/posts/[id]/page.tsx" apps/web/components/content-agent/PostsTab.tsx
git commit -m "feat(web): Story badge on post detail targets and the posts list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Full verification

- [ ] **Step 1:** `pnpm test` — full vitest run, all green; note the total and compare with the pre-change baseline on `main` (run `git stash`-free: check out `main` in a throwaway worktree if a suite fails and looks pre-existing).
- [ ] **Step 2:** `pnpm type-check` — 10/10 packages.
- [ ] **Step 3:** `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` — clean.
- [ ] **Step 4:** Golden gates unchanged: `npx vitest run repurpose-render-golden super-text-render-golden` — PASS with **0 snapshots written**.
- [ ] **Step 5:** Browser walk-through on the local dev server (`docker compose up -d`, `pnpm dev`, sign in): Compose → click **Story** → channel list shows only Instagram; a group pill shows only its Instagram count and clicking selects only those; non-IG picks are pruned with a toast; attach two images → amber warning + buttons disabled with the reason in the tooltip; remove one → enabled; type `@nasa, natgeo bad-name` in Tag people → two chips + an error naming `bad-name`; preview shows a 9:16 frame with chips; switch back to **Post** → all cards return, selection intact. Save as Draft in story mode → the Posts list shows "Story ·"; post detail shows a Story badge and the note.
- [ ] **Step 6:** `find . -name "* 2.*" -not -path "./node_modules/*" -not -path "./.git/*"` → empty.

---

### Task 11: Documentation + memory

- [ ] **Step 1:** Add a `## 📸 Instagram STORIES from Content Studio (2026-09-15)` section to `CLAUDE.md` near the thumbnail/super-text sections covering: how story mode is represented (format STORY on every target + `metadata.instagramStory`), the Meta contract facts (STORIES container for image+video, `user_tags` on stories, no cover/collaborators/alt_text, 24h expiry, `/media` never lists stories), the invariants (never adopt via `/media` for a story; pre-write pre-flight returns null; exactly-one candidate rule; no AI auto-image for stories; only the 24h at-age checkpoint; `channelUsername` metadata only for stories; content may be empty in story mode), the UI rules (IG-only channels/groups, one media, mentions ≤20, Post Format/Captions/thumbnail hidden), and the test files.
- [ ] **Step 2:** Write memory `project-instagram-stories-2026-09-15.md` + index line in `MEMORY.md`.
- [ ] **Step 3:** Commit: `docs(claude): Instagram Stories — representation, Meta contract, invariants, tests`.
