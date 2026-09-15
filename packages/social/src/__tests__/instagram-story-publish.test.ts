import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";

/**
 * Instagram STORIES publishing (2026-09-15).
 *
 * The contract these tests lock:
 *   1. an image story is a STORIES container with `image_url` (+ `user_tags`
 *      when mentions exist); a video story is STORIES with `video_url` and
 *      NEVER a `cover_url` (Meta rejects it and fails the whole publish);
 *   2. a NON-story request is BYTE-IDENTICAL to the pre-feature body — asserted
 *      on the serialized JSON, not on key presence;
 *   3. a STORY-MODE post refuses 2+ media before any network call, while the
 *      pre-existing per-channel Story picker keeps publishing a carousel;
 *   4. duplicate prevention is keyed on the CONTAINER, never on "a story
 *      appeared recently" — the account posts stories constantly and the same IG
 *      account can be connected to several organizations;
 *   5. a PUBLISHED container whose media cannot be named is still PUBLISHED.
 */

const IG_USER = "17841400000000000";

interface Call {
  url: string;
  method: string;
  raw?: string;
  body?: any;
}

function mockGraph(handler: (url: string, method: string) => { ok: boolean; status?: number; body: any }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const raw = typeof init?.body === "string" ? init.body : undefined;
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      calls.push({ url: String(url), method, raw, body });
      const { ok, body: res, status } = handler(String(url), method);
      return { ok, status: status ?? (ok ? 200 : 400), json: async () => res, headers: { get: () => null } } as any;
    })
  );
  return calls;
}

/** Makes the provider's backoff sleeps instant so attempt exhaustion is testable. */
function instantSleep() {
  vi.stubGlobal("setTimeout", ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
}

const isCreateContainer = (c: Call) =>
  c.method === "POST" && c.url.includes(`/${IG_USER}/media`) && !c.url.includes("media_publish");
const createCalls = (calls: Call[]) => calls.filter(isCreateContainer);
const containerBody = (calls: Call[]) => createCalls(calls)[0]!.body;

/** Happy path: container created, ready, published; no permalink returned. */
const happyGraph = () =>
  mockGraph((url, method) => {
    if (url.includes("/media_publish")) return { ok: true, body: { id: "9001" } };
    if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "container-1" } };
    if (url.includes("status_code,status")) return { ok: true, body: { status_code: "FINISHED" } };
    if (url.includes("fields=permalink")) return { ok: true, body: {} };
    return { ok: true, body: {} };
  });

const storyList = (rows: Array<{ id: string; kind?: "IMAGE" | "VIDEO"; minutesAgo?: number; permalink?: string }>) => ({
  data: rows.map((r) => ({
    id: r.id,
    timestamp: new Date(Date.now() - (r.minutesAgo ?? 0) * 60_000).toISOString(),
    media_type: r.kind ?? "IMAGE",
    ...(r.permalink ? { permalink: r.permalink } : {}),
  })),
});

const TRANSIENT = {
  error: { message: "An unexpected error has occurred. Please retry your request later.", type: "OAuthException", is_transient: true, code: 2 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Instagram story containers", () => {
  it("image story → media_type STORIES + image_url + user_tags, and a /stories/ URL", async () => {
    const calls = happyGraph();
    instantSleep();
    const checkpoints: any[] = [];

    const res = await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "",
        mediaUrls: ["https://cdn.example.com/a.jpg"],
        mediaTypes: ["image/jpeg"],
        metadata: {
          igUserId: IG_USER,
          format: "STORY",
          instagramStory: { mentions: ["natgeo", "@nasa"] },
          channelUsername: "myacct",
        },
        onCheckpoint: (patch) => {
          checkpoints.push(patch);
        },
      }
    );

    expect(containerBody(calls)).toEqual({
      caption: "",
      media_type: "STORIES",
      image_url: "https://cdn.example.com/a.jpg",
      user_tags: [{ username: "natgeo" }, { username: "nasa" }],
      access_token: "t",
    });
    expect(res.platformPostId).toBe("9001");
    // `/p/{id}` is a 404 for a story.
    expect(res.url).toBe("https://www.instagram.com/stories/myacct/9001/");
    // The container id is checkpointed BEFORE publishing — that is what makes a
    // retry resumable instead of duplicating.
    expect(checkpoints).toEqual([
      {
        igStoryContainer: {
          id: "container-1",
          createdAt: expect.any(String),
          windowStart: expect.any(String),
          kind: "IMAGE",
        },
      },
    ]);
    // createdAt is the TRUE creation time; windowStart is deliberately earlier.
    const cp = checkpoints[0].igStoryContainer;
    expect(new Date(cp.windowStart).getTime()).toBeLessThan(new Date(cp.createdAt).getTime());
  });

  it("image story without mentions sends no user_tags key at all", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "note",
        mediaUrls: ["https://cdn.example.com/a.jpg"],
        mediaTypes: ["image/jpeg"],
        metadata: { igUserId: IG_USER, format: "STORY", instagramStory: { mentions: [] } },
      }
    );
    expect(containerBody(calls)).toEqual({
      caption: "note",
      media_type: "STORIES",
      image_url: "https://cdn.example.com/a.jpg",
      access_token: "t",
    });
  });

  it("video story → STORIES + video_url + user_tags, and NEVER cover_url", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "",
        mediaUrls: ["https://cdn.example.com/v.mp4"],
        mediaTypes: ["video/mp4"],
        metadata: {
          igUserId: IG_USER,
          format: "STORY",
          instagramStory: { mentions: ["friend"] },
          // A cover set in Post mode must never reach a STORIES container: Meta
          // 400s container creation and the whole publish fails.
          videoThumbnail: { mediaId: "m", url: "https://cdn.example.com/cover.jpg" },
        },
      }
    );
    const body = containerBody(calls);
    expect(body.media_type).toBe("STORIES");
    expect(body.video_url).toBe("https://cdn.example.com/v.mp4");
    expect(body.user_tags).toEqual([{ username: "friend" }]);
    expect(body).not.toHaveProperty("cover_url");
  });

  it("a NON-story image request is BYTE-IDENTICAL to the pre-feature body", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "hello",
        mediaUrls: ["https://cdn.example.com/a.jpg"],
        mediaTypes: ["image/jpeg"],
        metadata: { igUserId: IG_USER },
      }
    );
    // Serialized, not key-by-key: JSON.stringify preserves insertion order, so
    // this catches a reordered or extra field that a shape comparison would miss.
    expect(createCalls(calls)[0]!.raw).toBe(
      JSON.stringify({ caption: "hello", image_url: "https://cdn.example.com/a.jpg", access_token: "t" })
    );
  });

  it("a NON-story REEL request is BYTE-IDENTICAL to the pre-feature body", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "hi",
        mediaUrls: ["https://cdn.example.com/v.mp4"],
        mediaTypes: ["video/mp4"],
        metadata: { igUserId: IG_USER, format: "REEL" },
      }
    );
    expect(createCalls(calls)[0]!.raw).toBe(
      JSON.stringify({ caption: "hi", video_url: "https://cdn.example.com/v.mp4", media_type: "REELS", access_token: "t" })
    );
  });

  it("a STORY-MODE post with more than one attachment throws before any network call", async () => {
    const calls = happyGraph();
    await expect(
      new InstagramProvider().publishPost(
        { accessToken: "t" },
        {
          content: "",
          mediaUrls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
          mediaTypes: ["image/jpeg", "image/jpeg"],
          metadata: { igUserId: IG_USER, format: "STORY", instagramStory: { mentions: [] } },
        }
      )
    ).rejects.toThrow(/exactly one image or video/);
    expect(calls).toHaveLength(0);
  });

  it("the per-channel Story PICKER with 2 media still publishes a carousel (no behaviour change)", async () => {
    // format STORY with NO instagramStory marker = the pre-existing picker path.
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "c",
        mediaUrls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
        mediaTypes: ["image/jpeg", "image/jpeg"],
        metadata: { igUserId: IG_USER, format: "STORY" },
      }
    );
    expect(calls.some((c) => c.body?.media_type === "CAROUSEL")).toBe(true);
  });

  it("names the offending tag when Instagram rejects a user_tag", async () => {
    mockGraph((url, method) => {
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) {
        return { ok: false, body: { error: { message: "Invalid user_tags: user ghostuser does not exist", code: 100 } } };
      }
      return { ok: true, body: {} };
    });
    instantSleep();
    await expect(
      new InstagramProvider().publishPost(
        { accessToken: "t" },
        {
          content: "",
          mediaUrls: ["https://cdn.example.com/a.jpg"],
          mediaTypes: ["image/jpeg"],
          metadata: { igUserId: IG_USER, format: "STORY", instagramStory: { mentions: ["ghostuser"] } },
        }
      )
    ).rejects.toThrow(/@ghostuser.*public/s);
  });
});

describe("Instagram story checkpoint is FATAL pre-write, never best-effort", () => {
  it("aborts BEFORE publishing when the container id cannot be recorded", async () => {
    // The checkpoint is the only thing that lets a retry find this container. If
    // it is lost and the PUBLISHED write downstream fails too (same client, same
    // database), a retry would post a second live story. Aborting here is safe:
    // nothing has been sent to Instagram yet.
    const calls = happyGraph();
    instantSleep();

    await expect(
      new InstagramProvider().publishPost(
        { accessToken: "t" },
        {
          content: "",
          mediaUrls: ["https://cdn.example.com/a.jpg"],
          mediaTypes: ["image/jpeg"],
          metadata: { igUserId: IG_USER, format: "STORY", instagramStory: { mentions: [] } },
          onCheckpoint: async () => {
            throw new Error("connection pool exhausted");
          },
        }
      )
    ).rejects.toThrow(/Could not record the Instagram story container container-1.*Nothing was sent to Instagram/s);

    expect(calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });

  it("identifies a resumed story using windowStart, not the true creation time", async () => {
    // The story's own Meta timestamp can precede the recorded createdAt; the
    // back-dated window is what guarantees it is not filtered out.
    const createdAt = new Date(Date.now() - 60_000);
    const windowStart = new Date(createdAt.getTime() - 120_000);
    const storyTimestamp = new Date(createdAt.getTime() - 30_000); // between the two

    mockGraph((url) => {
      if (url.includes("/container-1?fields=status_code")) return { ok: true, body: { status_code: "PUBLISHED" } };
      if (url.includes(`/${IG_USER}/stories`)) {
        return {
          ok: true,
          body: { data: [{ id: "4242", timestamp: storyTimestamp.toISOString(), media_type: "IMAGE" }] },
        };
      }
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "",
        mediaUrls: ["https://cdn.example.com/a.jpg"],
        mediaTypes: ["image/jpeg"],
        metadata: {
          igUserId: IG_USER,
          format: "STORY",
          channelUsername: "acct",
          igStoryContainer: {
            id: "container-1",
            createdAt: createdAt.toISOString(),
            windowStart: windowStart.toISOString(),
            kind: "IMAGE",
          },
        },
      }
    );
    // With createdAt as the floor this story would have been excluded and the
    // result reported as unresolved.
    expect(res.platformPostId).toBe("4242");
  });
});

describe("Instagram story duplicate prevention — the container is the identity", () => {
  const storyPayload = (extra: Record<string, unknown> = {}) => ({
    content: "",
    mediaUrls: ["https://cdn.example.com/a.jpg"],
    mediaTypes: ["image/jpeg"],
    metadata: { igUserId: IG_USER, format: "STORY", channelUsername: "acct", ...extra },
  });

  it("a checkpointed container reported PUBLISHED is adopted — no second container", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("/container-1?fields=status_code")) return { ok: true, body: { status_code: "PUBLISHED" } };
      if (url.includes(`/${IG_USER}/stories`)) {
        return { ok: true, body: storyList([{ id: "555", permalink: "https://www.instagram.com/stories/acct/555/" }]) };
      }
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost(
      { accessToken: "t" },
      storyPayload({
        igStoryContainer: { id: "container-1", createdAt: new Date(Date.now() - 60_000).toISOString(), kind: "IMAGE" },
      })
    );

    expect(res.platformPostId).toBe("555");
    expect(res.url).toBe("https://www.instagram.com/stories/acct/555/");
    expect(createCalls(calls)).toHaveLength(0);
    expect(calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });

  it("a PUBLISHED container whose media cannot be named is STILL published, not failed", async () => {
    // Several stories in the window (the account posts constantly) — we refuse to
    // guess which is ours, but the container already proved it is live.
    const calls = mockGraph((url) => {
      if (url.includes("/container-1?fields=status_code")) return { ok: true, body: { status_code: "PUBLISHED" } };
      if (url.includes(`/${IG_USER}/stories`)) return { ok: true, body: storyList([{ id: "a" }, { id: "b" }]) };
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost(
      { accessToken: "t" },
      storyPayload({
        igStoryContainer: { id: "container-1", createdAt: new Date(Date.now() - 60_000).toISOString(), kind: "IMAGE" },
      })
    );

    expect(res.platformPostId).toBe("container-1");
    expect(res.url).toBe("https://www.instagram.com/stories/acct/");
    expect(res.metadata?.storyMediaUnresolved).toBe(true);
    expect(createCalls(calls)).toHaveLength(0);
  });

  it("a still-usable container is REUSED rather than replaced", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("/container-1?fields=status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes("status_code,status")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes("/media_publish")) return { ok: true, body: { id: "777" } };
      if (url.includes("fields=permalink")) return { ok: true, body: {} };
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost(
      { accessToken: "t" },
      storyPayload({
        igStoryContainer: { id: "container-1", createdAt: new Date(Date.now() - 60_000).toISOString(), kind: "IMAGE" },
      })
    );

    expect(res.platformPostId).toBe("777");
    expect(createCalls(calls)).toHaveLength(0);
    expect(calls.find((c) => c.url.includes("media_publish"))!.body.creation_id).toBe("container-1");
  });

  it("an explicitly dead container earns a fresh one", async () => {
    const calls = mockGraph((url, method) => {
      // ⚠️ media_publish BEFORE the /media create branch — "media_publish"
      // contains "media", so the looser test would swallow it.
      if (url.includes("/media_publish")) return { ok: true, body: { id: "888" } };
      if (url.includes("/container-1?fields=status_code")) return { ok: true, body: { status_code: "EXPIRED" } };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "container-2" } };
      if (url.includes("status_code,status")) return { ok: true, body: { status_code: "FINISHED" } };
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost(
      { accessToken: "t" },
      storyPayload({
        igStoryContainer: { id: "container-1", createdAt: new Date(Date.now() - 60_000).toISOString(), kind: "IMAGE" },
      })
    );

    expect(res.platformPostId).toBe("888");
    expect(createCalls(calls)).toHaveLength(1);
  });

  it("an UNREADABLE recent container status throws — it never creates a second container", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("/container-1?fields=status_code")) {
        return { ok: false, body: { error: { message: "temporarily unavailable", code: 2 } } };
      }
      return { ok: true, body: {} };
    });
    instantSleep();

    await expect(
      new InstagramProvider().publishPost(
        { accessToken: "t" },
        storyPayload({
          igStoryContainer: { id: "container-1", createdAt: new Date(Date.now() - 60_000).toISOString(), kind: "IMAGE" },
        })
      )
    ).rejects.toThrow(/refusing to create a second container/);
    expect(createCalls(calls)).toHaveLength(0);
  });

  it("a container older than its 24h lifetime is treated as expired, so retries are not wedged forever", async () => {
    const calls = mockGraph((url, method) => {
      if (url.includes("/media_publish")) return { ok: true, body: { id: "999" } };
      if (url.includes("/container-1?fields=status_code")) return { ok: false, body: { error: { message: "not found", code: 100 } } };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "container-2" } };
      if (url.includes("status_code,status")) return { ok: true, body: { status_code: "FINISHED" } };
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost(
      { accessToken: "t" },
      storyPayload({
        igStoryContainer: {
          id: "container-1",
          createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
          kind: "IMAGE",
        },
      })
    );
    expect(res.platformPostId).toBe("999");
    expect(createCalls(calls)).toHaveLength(1);
  });

  it("a transient media_publish failure adopts the story when the container says PUBLISHED", async () => {
    let publishAttempts = 0;
    const calls = mockGraph((url, method) => {
      if (url.includes("/media_publish")) {
        publishAttempts++;
        return { ok: false, body: TRANSIENT };
      }
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "container-1" } };
      if (url.includes("status_code,status")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes("/container-1?fields=status_code")) return { ok: true, body: { status_code: "PUBLISHED" } };
      if (url.includes(`/${IG_USER}/stories`)) return { ok: true, body: storyList([{ id: "321" }]) };
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost({ accessToken: "t" }, storyPayload());

    expect(res.platformPostId).toBe("321");
    expect(publishAttempts).toBe(1); // recovered on the first ambiguous response
    expect(createCalls(calls)).toHaveLength(1);
    // NEVER consults /media for a story — a same-caption FEED post is not our story.
    expect(calls.some((c) => c.url.includes(`/${IG_USER}/media?`))).toBe(false);
  });

  it("parks as AMBIGUOUS when the container never reports PUBLISHED", async () => {
    mockGraph((url, method) => {
      if (url.includes("/media_publish")) return { ok: false, body: TRANSIENT };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "container-1" } };
      if (url.includes("status_code,status")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes("/container-1?fields=status_code")) return { ok: true, body: { status_code: "IN_PROGRESS" } };
      return { ok: true, body: {} };
    });
    instantSleep();

    await expect(new InstagramProvider().publishPost({ accessToken: "t" }, storyPayload())).rejects.toSatisfy(
      (e: unknown) => isAmbiguousPublishError(e)
    );
  });

  it("never adopts a story on the LISTING alone — a foreign story must not be claimed", async () => {
    // The container is NOT published (our publish genuinely failed) while exactly
    // one story sits in the window: someone posted from the phone, or another org
    // sharing this IG account published. Adopting it would mark us PUBLISHED and
    // the user's story would never go out.
    mockGraph((url, method) => {
      if (url.includes("/media_publish")) return { ok: false, body: TRANSIENT };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "container-1" } };
      if (url.includes("status_code,status")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes("/container-1?fields=status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes(`/${IG_USER}/stories`)) return { ok: true, body: storyList([{ id: "someone-elses" }]) };
      return { ok: true, body: {} };
    });
    instantSleep();

    await expect(new InstagramProvider().publishPost({ accessToken: "t" }, storyPayload())).rejects.toSatisfy(
      (e: unknown) => isAmbiguousPublishError(e)
    );
  });

  it("the pre-write pre-flight never adopts anything for a story, and makes no call", async () => {
    const calls = mockGraph(() => ({ ok: true, body: storyList([{ id: "x" }]) }));
    const res = await new InstagramProvider().findExistingPost!(
      { accessToken: "t" },
      storyPayload(),
      new Date(Date.now() - 60_000)
    );
    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
