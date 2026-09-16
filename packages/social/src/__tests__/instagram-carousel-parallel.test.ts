import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";

/**
 * Instagram carousel children are created + awaited with bounded parallelism
 * (2026-09-16). They used to go strictly one at a time, so a 10-slide carousel
 * waited out ten create→FINISHED cycles back to back.
 *
 * A child is only a container — nothing is published until the carousel's own
 * media_publish — so parallelism cannot create a post. The contract locked here:
 *   1. the carousel's `children` array is in INPUT order, whatever order the
 *      children finish in (that array IS the slide order);
 *   2. at most 3 children are in flight at once;
 *   3. a failure rejects only after every STARTED child has settled, starts no
 *      new child, and surfaces the LOWEST failing index's error (what the
 *      sequential loop would have thrown);
 *   4. a video child gets the same long ready budget as a single reel, not 90s;
 *   5. every request body is byte-identical to the sequential implementation.
 */

const IG_USER = "17841400000000000";

interface Call {
  url: string;
  method: string;
  raw?: string;
  body?: any;
}

interface Reply {
  ok: boolean;
  status?: number;
  body: any;
}

function stubGraph(handler: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const raw = typeof init?.body === "string" ? init.body : undefined;
      const call: Call = { url: String(url), method, raw, body: raw ? JSON.parse(raw) : undefined };
      calls.push(call);
      const r = await handler(call);
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 400),
        json: async () => r.body,
        headers: { get: () => null },
      } as any;
    })
  );
  return calls;
}

/** Makes every provider sleep instant, recording the requested delays. */
function instantSleep(): number[] {
  const delays: number[] = [];
  vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  return delays;
}

/** Drain pending promise chains (setImmediate is not stubbed by instantSleep). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}

const isChildCreate = (c: Call) =>
  c.method === "POST" && c.url.endsWith(`/${IG_USER}/media`) && c.body?.is_carousel_item === true;
const isCarouselCreate = (c: Call) =>
  c.method === "POST" && c.url.endsWith(`/${IG_USER}/media`) && c.body?.media_type === "CAROUSEL";
const isPublish = (c: Call) => c.url.includes("/media_publish");
/** `.../x3.jpg` → `child-3`. */
const childIdFor = (body: any) => `child-${/x(\d+)\./.exec(body.image_url ?? body.video_url)![1]}`;
/** The container id a status poll is asking about, or null. */
const polledId = (c: Call) => /\/([^/?]+)\?fields=status_code,status/.exec(c.url)?.[1] ?? null;

const image = (i: number) => `https://cdn.example.com/x${i}.jpg`;
const payloadOf = (mediaUrls: string[], mediaTypes?: string[]) => ({
  content: "slides",
  mediaUrls,
  mediaTypes: mediaTypes ?? mediaUrls.map(() => "image/jpeg"),
  metadata: { igUserId: IG_USER },
});

/** The routes every scenario shares; `status` decides child poll answers. */
function commonReply(call: Call, status: (id: string) => Reply): Reply | null {
  if (isPublish(call)) return { ok: true, body: { id: "carousel-post-1" } };
  if (isCarouselCreate(call)) return { ok: true, body: { id: "carousel-1" } };
  if (call.url.includes("fields=permalink")) return { ok: true, body: { permalink: "https://www.instagram.com/p/carousel/" } };
  const id = polledId(call);
  if (id === "carousel-1") return { ok: true, body: { status_code: "FINISHED" } };
  if (id) return status(id);
  return null;
}

type Gate = { release: (reply?: Reply) => void };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Instagram carousel — bounded-parallel children", () => {
  it("keeps the children in INPUT order even when later children finish first", async () => {
    // child-0 is the slowest to process, child-2/child-3 are instant.
    const pollsNeeded: Record<string, number> = { "child-0": 4, "child-1": 2, "child-2": 0, "child-3": 0 };
    const pollsSeen: Record<string, number> = {};
    const finishOrder: string[] = [];

    const calls = stubGraph((call) => {
      if (isChildCreate(call)) return { ok: true, body: { id: childIdFor(call.body) } };
      const shared = commonReply(call, (id) => {
        pollsSeen[id] = (pollsSeen[id] ?? 0) + 1;
        if (pollsSeen[id]! > pollsNeeded[id]!) {
          finishOrder.push(id);
          return { ok: true, body: { status_code: "FINISHED" } };
        }
        return { ok: true, body: { status_code: "IN_PROGRESS" } };
      });
      return shared ?? { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost(
      { accessToken: "t" },
      payloadOf([image(0), image(1), image(2), image(3)])
    );

    expect(res.platformPostId).toBe("carousel-post-1");
    // Completion order genuinely differed from input order…
    expect(finishOrder.indexOf("child-2")).toBeLessThan(finishOrder.indexOf("child-0"));
    expect(finishOrder.indexOf("child-1")).toBeLessThan(finishOrder.indexOf("child-0"));
    // …but the slide order sent to Instagram is the input order, byte-for-byte.
    const carousel = calls.filter(isCarouselCreate);
    expect(carousel).toHaveLength(1);
    expect(carousel[0]!.raw).toBe(
      JSON.stringify({
        media_type: "CAROUSEL",
        caption: "slides",
        children: ["child-0", "child-1", "child-2", "child-3"],
        access_token: "t",
      })
    );
    // Every child finished before the carousel container was created.
    const carouselIdx = calls.findIndex(isCarouselCreate);
    for (const id of ["child-0", "child-1", "child-2", "child-3"]) {
      const lastPoll = calls.map((c, i) => (polledId(c) === id ? i : -1)).filter((i) => i >= 0).pop()!;
      expect(lastPoll).toBeLessThan(carouselIdx);
    }
    // Exactly one publish, of the carousel container.
    expect(calls.filter(isPublish)).toHaveLength(1);
    expect(calls.find(isPublish)!.body.creation_id).toBe("carousel-1");
  });

  it("child create bodies are byte-identical to the sequential implementation", async () => {
    const calls = stubGraph((call) => {
      if (isChildCreate(call)) return { ok: true, body: { id: childIdFor(call.body) } };
      return commonReply(call, () => ({ ok: true, body: { status_code: "FINISHED" } })) ?? { ok: true, body: {} };
    });
    instantSleep();

    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      payloadOf([image(0), "https://cdn.example.com/x1.mp4"], ["image/jpeg", "video/mp4"])
    );

    const raws = calls.filter(isChildCreate).map((c) => c.raw);
    expect(raws).toEqual([
      JSON.stringify({ is_carousel_item: true, access_token: "t", image_url: image(0) }),
      JSON.stringify({
        is_carousel_item: true,
        access_token: "t",
        video_url: "https://cdn.example.com/x1.mp4",
        media_type: "VIDEO",
      }),
    ]);
  });

  it("never has more than 3 child creations in flight", async () => {
    const gates = new Map<string, Gate>();
    let pending = 0;
    let maxPending = 0;

    const calls = stubGraph((call) => {
      if (isChildCreate(call)) {
        const id = childIdFor(call.body);
        pending++;
        maxPending = Math.max(maxPending, pending);
        return new Promise<Reply>((resolve) => {
          gates.set(id, {
            release: (reply) => {
              pending--;
              resolve(reply ?? { ok: true, body: { id } });
            },
          });
        });
      }
      return commonReply(call, () => ({ ok: true, body: { status_code: "FINISHED" } })) ?? { ok: true, body: {} };
    });
    instantSleep();

    const promise = new InstagramProvider().publishPost(
      { accessToken: "t" },
      payloadOf([0, 1, 2, 3, 4].map(image))
    );

    await flush();
    // Three lanes, all blocked on their create.
    expect(calls.filter(isChildCreate).map((c) => childIdFor(c.body))).toEqual(["child-0", "child-1", "child-2"]);

    // Freeing ONE lane starts exactly ONE more child.
    gates.get("child-1")!.release();
    await flush();
    expect(calls.filter(isChildCreate)).toHaveLength(4);
    expect(childIdFor(calls.filter(isChildCreate)[3]!.body)).toBe("child-3");

    gates.get("child-0")!.release();
    await flush();
    expect(calls.filter(isChildCreate)).toHaveLength(5);

    for (const id of ["child-2", "child-3", "child-4"]) {
      gates.get(id)!.release();
      await flush();
    }

    const res = await promise;
    expect(res.platformPostId).toBe("carousel-post-1");
    expect(maxPending).toBe(3);
    // Order still follows the input, not the release order (1, 0, 2, 3, 4).
    expect(calls.find(isCarouselCreate)!.body.children).toEqual([
      "child-0",
      "child-1",
      "child-2",
      "child-3",
      "child-4",
    ]);
  });

  it("a failing child rejects only after every started child settles, and starts no new child", async () => {
    const gates = new Map<string, Gate>();
    const finished = new Set<string>();

    const calls = stubGraph((call) => {
      if (isChildCreate(call)) {
        const id = childIdFor(call.body);
        if (id === "child-1") {
          return { ok: false, body: { error: { code: 9004, message: "child-1 media could not be fetched" } } };
        }
        return new Promise<Reply>((resolve) => {
          gates.set(id, { release: (reply) => resolve(reply ?? { ok: true, body: { id } }) });
        });
      }
      return (
        commonReply(call, (id) => {
          finished.add(id);
          return { ok: true, body: { status_code: "FINISHED" } };
        }) ?? { ok: true, body: {} }
      );
    });
    instantSleep();

    let settled = false;
    const outcome = new InstagramProvider()
      .publishPost({ accessToken: "t" }, payloadOf([0, 1, 2, 3, 4].map(image)))
      .then(
        (r) => {
          settled = true;
          return r;
        },
        (e) => {
          settled = true;
          return e;
        }
      );

    await flush();
    // child-1 has already failed, but child-0 and child-2 are still running.
    expect(calls.filter(isChildCreate)).toHaveLength(3);
    expect(settled).toBe(false);

    gates.get("child-0")!.release();
    await flush();
    expect(finished.has("child-0")).toBe(true);
    expect(settled).toBe(false);
    // No new child is started once the carousel can no longer be built.
    expect(calls.filter(isChildCreate)).toHaveLength(3);

    gates.get("child-2")!.release();
    const err = await outcome;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^Instagram carousel item upload failed: .*child-1 media could not be fetched/);
    // Both in-flight children ran to completion before the rejection surfaced.
    expect(finished.has("child-2")).toBe(true);
    // Nothing downstream happened.
    expect(calls.filter(isCarouselCreate)).toHaveLength(0);
    expect(calls.filter(isPublish)).toHaveLength(0);
  });

  it("surfaces the LOWEST failing index, even when a later child fails first", async () => {
    const gates = new Map<string, Gate>();

    stubGraph((call) => {
      if (isChildCreate(call)) {
        const id = childIdFor(call.body);
        if (id === "child-2") {
          return { ok: false, body: { error: { code: 9004, message: "child-2 failed first" } } };
        }
        return new Promise<Reply>((resolve) => {
          gates.set(id, { release: (reply) => resolve(reply ?? { ok: true, body: { id } }) });
        });
      }
      return commonReply(call, () => ({ ok: true, body: { status_code: "FINISHED" } })) ?? { ok: true, body: {} };
    });
    instantSleep();

    const outcome = new InstagramProvider()
      .publishPost({ accessToken: "t" }, payloadOf([0, 1, 2, 3].map(image)))
      .catch((e) => e);

    await flush();
    gates.get("child-1")!.release();
    await flush();
    // child-0 fails LATER than child-2 did, but it is the lower index.
    gates.get("child-0")!.release({ ok: false, body: { error: { code: 9004, message: "child-0 failed last" } } });

    const err = await outcome;
    expect(err.message).toContain("child-0 failed last");
    expect(err.message).not.toContain("child-2");
  });

  it("a video child waits with the long reel budget, not the old 90s", async () => {
    const pollsFor: Record<string, number> = {};
    stubGraph((call) => {
      if (isChildCreate(call)) return { ok: true, body: { id: childIdFor(call.body) } };
      return (
        commonReply(call, (id) => {
          pollsFor[id] = (pollsFor[id] ?? 0) + 1;
          // The video never finishes; the image does.
          return { ok: true, body: { status_code: id === "child-1" ? "IN_PROGRESS" : "FINISHED" } };
        }) ?? { ok: true, body: {} }
      );
    });
    const delays = instantSleep();

    const err = await new InstagramProvider()
      .publishPost(
        { accessToken: "t" },
        payloadOf([image(0), "https://cdn.example.com/x1.mp4"], ["image/jpeg", "video/mp4"])
      )
      .catch((e) => e);

    // VIDEO_READY_TIMEOUT_MS defaults to 240s (IG_VIDEO_READY_TIMEOUT_MS unset).
    expect(err.message).toMatch(/budget 240s/);
    // 240s / 5s = 48 polls — the old hard-coded 90s budget stopped at 18.
    expect(pollsFor["child-1"]).toBe(48);
    expect(delays).toContain(5000);
    // The image child kept its short 2s interval and finished on its first poll.
    expect(pollsFor["child-0"]).toBe(1);
    expect(delays).toContain(2000);
  });
});
