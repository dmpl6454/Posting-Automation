/**
 * Drives the REAL post-publish processor (2026-09-16) against an in-memory
 * PostTarget table, to lock the orphaned-claim fixes end to end:
 *
 *   - an 11-image Instagram post orphaned all 60 targets at PUBLISHING for
 *     30-56 min, because "Validation failed" was thrown after the atomic claim
 *     and before the publish try — and the BullMQ retry then lost the claim
 *     and completed silently as a "duplicate";
 *   - a deploy killed 10 in-flight publishes, which then sat at PUBLISHING
 *     until the 30-min reaper;
 *   - a dead Instagram token (190/460) retried into the duplicate pre-flight,
 *     which could not list the account and parked a false "may already have
 *     gone live" ambiguity (73 targets since 2026-09-14).
 *
 * BullMQ's Worker is replaced by a capture shim; everything the processor
 * decides is real. The Instagram provider is the real one with its network
 * methods replaced, so the validation message is the production string.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  let clock = 1_780_000_000_000;
  const tick = () => new Date(++clock);
  type Row = Record<string, any>;
  const rows = new Map<string, Row>();
  const s: {
    processor: ((job: any) => Promise<any>) | null;
    handlers: Record<string, (...a: any[]) => any>;
    post: any;
    channel: any;
    channelError: Error | null;
    provider: any;
    creds: { clientId: string; clientSecret: string } | null;
    /** Return true to make a postTarget.update throw (simulates a DB failure). */
    failUpdate: ((data: Row) => boolean) | null;
    /** Override the next postTarget.findUnique result (simulates a stale read). */
    staleRead: Row | null;
  } = {
    processor: null,
    handlers: {},
    post: null,
    channel: null,
    channelError: null,
    provider: null,
    creds: null,
    failUpdate: null,
    staleRead: null,
  };

  function matches(row: Row, where: Row): boolean {
    for (const [k, v] of Object.entries(where)) {
      const cur = row[k];
      if (v === null) {
        if (cur != null) return false;
      } else if (v instanceof Date) {
        if (!(cur instanceof Date) || cur.getTime() !== v.getTime()) return false;
      } else if (typeof v === "object") {
        if ("in" in v) {
          if (!(v.in as unknown[]).includes(cur)) return false;
        } else if ("lt" in v) {
          if (!(cur < v.lt)) return false;
        } else {
          throw new Error(`fake prisma: unsupported filter on ${k}`);
        }
      } else if (cur !== v) {
        return false;
      }
    }
    return true;
  }

  function apply(row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) {
        row[k] = (row[k] ?? 0) + (v as { increment: number }).increment;
      } else if (v !== undefined) {
        row[k] = v;
      }
    }
    row.updatedAt = tick();
  }

  const prisma = {
    postTarget: {
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = rows.get(where.id);
        if (!row || !matches(row, where)) return { count: 0 };
        apply(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (s.failUpdate?.(data)) throw new Error("db write failed");
        const row = rows.get(where.id);
        if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
        apply(row, data);
        return { ...row };
      }),
      findUnique: vi.fn(async ({ where }: { where: Row }) => {
        if (s.staleRead) {
          const stale = s.staleRead;
          s.staleRead = null;
          return stale;
        }
        const row = rows.get(where.id);
        return row ? { ...row } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => {
        const row = rows.get(where.id);
        if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
        return { ...row, post: s.post };
      }),
      findFirst: vi.fn(async () => null),
      // Post aggregation: a sibling that is still SCHEDULED keeps the post
      // non-terminal, so no report email is attempted.
      findMany: vi.fn(async () => [
        ...[...rows.values()].map((r) => ({ ...r, channel: { platform: "INSTAGRAM", name: "c", username: "c" } })),
        { id: "sibling", status: "SCHEDULED", channel: { platform: "INSTAGRAM", name: "s", username: "s" } },
      ]),
    },
    channel: {
      findFirst: vi.fn(async () => {
        if (s.channelError) throw s.channelError;
        return s.channel;
      }),
      update: vi.fn(async () => ({})),
    },
    post: {
      findUnique: vi.fn(async () => ({ scheduledAt: null, createdById: null })),
      update: vi.fn(async () => ({})),
    },
    media: { findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    notification: { create: vi.fn(async () => ({})) },
    organizationMember: { findMany: vi.fn(async () => []) },
    analyticsSnapshot: { create: vi.fn(async () => ({})) },
    errorLog: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => null) },
  };

  const queue = {
    postPublishQueue: { add: vi.fn(async () => ({})), getActive: vi.fn(async (): Promise<any[]> => []) },
    analyticsSyncQueue: { add: vi.fn(async () => ({})) },
    mediaOptimizeQueue: { add: vi.fn(async () => ({})) },
  };

  return { s, rows, tick, prisma, queue };
});

vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  class Worker {
    constructor(_name: string, processor: (job: any) => Promise<any>) {
      h.s.processor = processor;
    }
    on(event: string, fn: (...a: any[]) => any) {
      h.s.handlers[event] = fn;
      return this;
    }
  }
  return { ...actual, Worker };
});

vi.mock("ioredis", () => ({
  default: class {
    publish = async () => 1;
    on() {
      return this;
    }
  },
}));

vi.mock("@postautomation/db", () => ({
  prisma: h.prisma,
  // Re-exported by @postautomation/social; never called here.
  encryptToken: (v: string) => v,
  decryptToken: (v: string) => v,
  isEncrypted: () => false,
}));

vi.mock("@postautomation/queue", () => ({
  QUEUE_NAMES: { POST_PUBLISH: "post-publish" },
  PRIORITY_RETRY: 10,
  createRedisConnection: () => ({}),
  atAgeWindowsForFormat: () => [],
  postPublishQueue: h.queue.postPublishQueue,
  analyticsSyncQueue: h.queue.analyticsSyncQueue,
  mediaOptimizeQueue: h.queue.mediaOptimizeQueue,
}));

vi.mock("@postautomation/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social")>();
  return {
    ...actual,
    getSocialProvider: () => h.s.provider,
    resolvePlatformCredentials: () => h.s.creds,
  };
});

import { UnrecoverableError } from "bullmq";
import { createPostPublishWorker } from "../workers/post-publish.worker";
import { ORPHANED_CLAIM_MESSAGE, OPTIMIZE_WAIT_MESSAGE } from "../lib/publish-recovery";

const { s, rows, tick, prisma, queue } = h;

// The exact string production logged for a dead Instagram session.
const IG_DEAD_SESSION =
  'Instagram long-lived token exchange failed: {"error":{"message":"Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.","type":"OAuthException","code":190,"error_subcode":460}}';
const IG_PUBLISH_190 =
  'Instagram publish failed: {"error":{"message":"Error validating access token: Session has expired.","type":"OAuthException","code":190}}';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// The UNMOCKED factory (the imported one is mocked to return s.provider).
let realGetSocialProvider: (platform: string) => unknown;

function realProvider(platform: string, overrides: Record<string, unknown>) {
  // Object.create keeps the real validateContent/constraints without mutating
  // the factory's cached instance.
  return Object.assign(Object.create(realGetSocialProvider(platform) as object), {
    publishPost: vi.fn(),
    refreshAccessToken: vi.fn(),
    findExistingPost: vi.fn(async () => null),
    getPostAnalytics: vi.fn(async () => null),
    ...overrides,
  });
}

function image(i: number) {
  return { media: { id: `m${i}`, url: `https://cdn.example.com/img${i}.jpg`, fileType: "image/jpeg", fileSize: 1000, metadata: null } };
}

function seedTarget(id: string, over: Record<string, unknown> = {}) {
  rows.set(id, {
    id,
    postId: "post-1",
    channelId: "ch1",
    status: "SCHEDULED",
    publishedId: null,
    publishedUrl: null,
    errorMessage: null,
    retryCount: 0,
    ambiguousAt: null,
    ambiguousReason: null,
    format: null,
    metadata: null,
    contentOverride: null,
    uploadProgress: null,
    updatedAt: tick(),
    ...over,
  });
  return rows.get(id)!;
}

function seedPost(mediaAttachments: unknown[]) {
  s.post = {
    id: "post-1",
    organizationId: "org1",
    content: "Hello world",
    contentVariants: null,
    metadata: null,
    createdAt: new Date(),
    mediaAttachments,
  };
}

function seedChannel(platform: string) {
  s.channel = {
    id: "ch1",
    organizationId: "org1",
    platform,
    isActive: true,
    accessToken: "tok",
    refreshToken: "rt",
    tokenExpiresAt: null,
    metaAppId: null,
    metadata: { igUserId: "ig1" },
    name: "Channel",
    username: "channel",
  };
}

function makeJob(over: Record<string, any> = {}) {
  const now = Date.now();
  return {
    id: "job-1",
    name: "publish",
    data: { postId: "post-1", postTargetId: "t1", channelId: "ch1", platform: "INSTAGRAM", organizationId: "org1" },
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: now - 5_000,
    processedOn: now - 1_000,
    ...over,
  };
}

/** Runs the processor and returns the rejection (or undefined on success). */
async function runExpectingError(job: any): Promise<any> {
  try {
    await s.processor!(job);
  } catch (e) {
    return e;
  }
  throw new Error("expected the processor to throw");
}

/** Calls to postTarget.updateMany that are NOT the atomic claim. */
function nonClaimUpdateManyCalls() {
  return prisma.postTarget.updateMany.mock.calls.filter(
    ([arg]: any[]) => !(arg.where.status && typeof arg.where.status === "object" && "in" in arg.where.status)
  );
}

beforeAll(async () => {
  const actual = await vi.importActual<typeof import("@postautomation/social")>("@postautomation/social");
  realGetSocialProvider = actual.getSocialProvider as (platform: string) => unknown;
  createPostPublishWorker();
  expect(s.processor).toBeTypeOf("function");
});

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  s.channelError = null;
  s.failUpdate = null;
  s.staleRead = null;
  s.creds = { clientId: "cid", clientSecret: "csecret" };
  queue.postPublishQueue.getActive.mockResolvedValue([]);
  queue.postPublishQueue.add.mockResolvedValue({});
  seedChannel("INSTAGRAM");
  seedPost([image(1)]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deterministic pre-publish failures are terminal with the real reason", () => {
  it("an 11-image Instagram post fails at once — not orphaned, not a 'rate limit'", async () => {
    s.provider = realProvider("INSTAGRAM", {});
    seedPost(Array.from({ length: 11 }, (_, i) => image(i)));
    seedTarget("t1");

    const err = await runExpectingError(makeJob());

    const reason = "Validation failed: Too many media attachments. Instagram allows max 10.";
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe(reason);
    expect(rows.get("t1")).toMatchObject({ status: "FAILED", errorMessage: reason });
    expect(s.provider.publishPost).not.toHaveBeenCalled();

    // The failed handler keeps the real reason instead of "Platform rate limit hit".
    await s.handlers.failed!({ ...makeJob(), attemptsMade: 1 }, err);
    expect(rows.get("t1")).toMatchObject({ status: "FAILED", errorMessage: reason, retryCount: 1 });
  });

  it("a failed video optimization is terminal (UnrecoverableError + FAILED)", async () => {
    s.provider = realProvider("INSTAGRAM", {});
    seedPost([
      {
        media: {
          id: "v1",
          url: "https://cdn.example.com/v.mp4",
          fileType: "video/mp4",
          fileSize: 2 * 1024 ** 3,
          metadata: { optimize: { status: "failed", reasons: ["unsupported codec"] } },
        },
      },
    ]);
    seedTarget("t1");

    const err = await runExpectingError(makeJob());

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toContain("Video could not be optimized for Instagram (unsupported codec)");
    expect(rows.get("t1")).toMatchObject({ status: "FAILED", errorMessage: err.message });
    expect(s.provider.publishPost).not.toHaveBeenCalled();
  });
});

describe("pre-publish claim guard (Worker wrapper)", () => {
  it("releases the claim to FAILED when something throws before dispatch, and rethrows the original error", async () => {
    s.provider = realProvider("INSTAGRAM", {});
    seedTarget("t1");
    const boom = new Error("Connection terminated unexpectedly");
    s.channelError = boom;

    const err = await runExpectingError(makeJob());

    expect(err).toBe(boom); // not replaced, not made terminal → BullMQ retries normally
    expect(rows.get("t1")).toMatchObject({ status: "FAILED", errorMessage: boom.message });
    const release = nonClaimUpdateManyCalls();
    expect(release).toHaveLength(1);
    expect(release[0]![0].where).toEqual({ id: "t1", status: "PUBLISHING" });
    expect(s.provider.publishPost).not.toHaveBeenCalled();
  });

  it("the released target is re-claimed by the retry, which runs the duplicate pre-flight first", async () => {
    const publishPost = vi.fn(async () => ({ platformPostId: "ig-new", url: "https://instagram.com/p/new" }));
    s.provider = realProvider("INSTAGRAM", { publishPost });
    seedTarget("t1");
    s.channelError = new Error("Connection terminated unexpectedly");
    const err = await runExpectingError(makeJob());
    await s.handlers.failed!({ ...makeJob(), attemptsMade: 1 }, err);
    expect(rows.get("t1")).toMatchObject({ status: "FAILED", retryCount: 1 });

    s.channelError = null;
    await s.processor!(makeJob({ attemptsMade: 1 }));

    expect(s.provider.findExistingPost).toHaveBeenCalledTimes(1);
    expect(publishPost).toHaveBeenCalledTimes(1);
    expect(rows.get("t1")).toMatchObject({ status: "PUBLISHED", publishedId: "ig-new", errorMessage: null });
  });

  it("NEVER releases once dispatched — a failed FAILED-write after a publish error leaves PUBLISHING alone", async () => {
    s.provider = realProvider("INSTAGRAM", {
      publishPost: vi.fn(async () => {
        throw new Error("boom unexpected");
      }),
    });
    seedTarget("t1");
    // The generic else-branch write fails (and is swallowed there).
    s.failUpdate = (data) => data.status === "FAILED" && data.errorMessage === "boom unexpected";

    const err = await runExpectingError(makeJob());

    expect(err.message).toBe("boom unexpected");
    expect(nonClaimUpdateManyCalls()).toHaveLength(0);
    expect(rows.get("t1")!.status).toBe("PUBLISHING");
  });

  it("does not overwrite a terminal reason another branch already wrote", async () => {
    s.provider = realProvider("INSTAGRAM", {});
    seedPost(Array.from({ length: 11 }, (_, i) => image(i)));
    seedTarget("t1");

    await runExpectingError(makeJob());

    // The wrapper's release ran but matched nothing (status was already FAILED).
    const release = nonClaimUpdateManyCalls();
    expect(release).toHaveLength(1);
    const idx = prisma.postTarget.updateMany.mock.calls.indexOf(release[0]!);
    await expect(prisma.postTarget.updateMany.mock.results[idx]!.value).resolves.toEqual({ count: 0 });
    expect(rows.get("t1")!.errorMessage).toBe("Validation failed: Too many media attachments. Instagram allows max 10.");
  });
});

describe("claim-miss orphan recovery", () => {
  beforeEach(() => {
    s.provider = realProvider("INSTAGRAM", {});
  });

  it("releases a PUBLISHING target that no job holds and fails this attempt so BullMQ retries", async () => {
    seedTarget("t1", { status: "PUBLISHING" });
    queue.postPublishQueue.getActive.mockResolvedValue([
      { id: "job-1", data: { postTargetId: "t1" } }, // this job itself
      { id: "job-9", data: { postTargetId: "t2" } }, // a different target
      undefined, // Job.fromId can return undefined
    ]);

    const err = await runExpectingError(makeJob());

    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe(ORPHANED_CLAIM_MESSAGE);
    expect(rows.get("t1")).toMatchObject({ status: "FAILED", errorMessage: ORPHANED_CLAIM_MESSAGE });
    const release = nonClaimUpdateManyCalls();
    expect(release).toHaveLength(1);
    expect(release[0]![0].where).toMatchObject({ id: "t1", status: "PUBLISHING", publishedId: null });
    expect(release[0]![0].where.updatedAt).toBeInstanceOf(Date);
    expect(s.provider.publishPost).not.toHaveBeenCalled();
  });

  it("…and the retry adopts the post the dead holder had already published (no second publish)", async () => {
    seedTarget("t1", { status: "PUBLISHING" });
    const err = await runExpectingError(makeJob());

    // BullMQ's failed handler keeps the message verbatim and bumps retryCount.
    await s.handlers.failed!({ ...makeJob(), attemptsMade: 1 }, err);
    expect(rows.get("t1")).toMatchObject({ status: "FAILED", errorMessage: ORPHANED_CLAIM_MESSAGE, retryCount: 1 });

    s.provider.findExistingPost.mockResolvedValue({ platformPostId: "ig-live", url: "https://instagram.com/p/live" });
    await s.processor!(makeJob({ attemptsMade: 1 }));

    expect(s.provider.findExistingPost).toHaveBeenCalledTimes(1);
    expect(s.provider.publishPost).not.toHaveBeenCalled();
    expect(rows.get("t1")).toMatchObject({ status: "PUBLISHED", publishedId: "ig-live" });
  });

  it("skips when another active job holds the target", async () => {
    seedTarget("t1", { status: "PUBLISHING" });
    queue.postPublishQueue.getActive.mockResolvedValue([{ id: "job-2", data: { postTargetId: "t1" } }]);

    await expect(s.processor!(makeJob())).resolves.toBeUndefined();

    expect(rows.get("t1")!.status).toBe("PUBLISHING");
    expect(nonClaimUpdateManyCalls()).toHaveLength(0);
  });

  it("falls back to the old skip when the active-job lookup fails", async () => {
    seedTarget("t1", { status: "PUBLISHING" });
    queue.postPublishQueue.getActive.mockRejectedValue(new Error("Redis connection lost"));

    await expect(s.processor!(makeJob())).resolves.toBeUndefined();

    expect(rows.get("t1")!.status).toBe("PUBLISHING");
    expect(nonClaimUpdateManyCalls()).toHaveLength(0);
  });

  it("skips without touching Redis when the target is already PUBLISHED or has a platform id", async () => {
    seedTarget("t1", { status: "PUBLISHED", publishedId: "ig-1" });
    await expect(s.processor!(makeJob())).resolves.toBeUndefined();

    seedTarget("t1", { status: "PUBLISHING", publishedId: "ig-1" });
    await expect(s.processor!(makeJob())).resolves.toBeUndefined();

    expect(queue.postPublishQueue.getActive).not.toHaveBeenCalled();
    expect(nonClaimUpdateManyCalls()).toHaveLength(0);
  });

  it("skips when the row changed between the read and the release (conditional on updatedAt)", async () => {
    const row = seedTarget("t1", { status: "PUBLISHING" });
    s.staleRead = { ...row, updatedAt: new Date(row.updatedAt.getTime() - 60_000) };

    await expect(s.processor!(makeJob())).resolves.toBeUndefined();

    expect(nonClaimUpdateManyCalls()).toHaveLength(1); // attempted…
    expect(rows.get("t1")!.status).toBe("PUBLISHING"); // …but matched nothing
  });

  it("keeps the final-attempt terminalize exactly as before", async () => {
    seedTarget("t1", { status: "PUBLISHING" });

    await expect(s.processor!(makeJob({ attemptsMade: 2 }))).resolves.toBeUndefined();

    expect(rows.get("t1")).toMatchObject({
      status: "FAILED",
      errorMessage: "Publishing did not complete after all retries — please retry.",
      retryCount: 0,
    });
    expect(queue.postPublishQueue.getActive).not.toHaveBeenCalled();
  });

  it("never treats a still-running copy of the SAME job id (lapsed lock) as an orphan", async () => {
    const gate = deferred<{ platformPostId: string; url: string }>();
    const publishPost = vi.fn(() => gate.promise);
    s.provider = realProvider("INSTAGRAM", { publishPost });
    seedTarget("t1");

    const first = s.processor!(makeJob());
    await vi.waitFor(() => expect(publishPost).toHaveBeenCalled());
    expect(rows.get("t1")!.status).toBe("PUBLISHING");

    // BullMQ re-runs job-1 (stalled checker) while the first run is still publishing.
    queue.postPublishQueue.getActive.mockResolvedValue([{ id: "job-1", data: { postTargetId: "t1" } }]);
    await expect(s.processor!(makeJob())).resolves.toBeUndefined();
    expect(rows.get("t1")!.status).toBe("PUBLISHING");
    expect(nonClaimUpdateManyCalls()).toHaveLength(0);

    gate.resolve({ platformPostId: "ig-1", url: "https://instagram.com/p/1" });
    await first;
    expect(rows.get("t1")).toMatchObject({ status: "PUBLISHED", publishedId: "ig-1" });

    // The local claim was released: a genuine orphan on the same target is recoverable again.
    seedTarget("t1", { status: "PUBLISHING" });
    const err = await runExpectingError(makeJob());
    expect(err.message).toBe(ORPHANED_CLAIM_MESSAGE);
  });
});

describe("dead token fails fast instead of retrying into a false ambiguity", () => {
  it("refresh failed with a definite auth error → UnrecoverableError, publish attempted once", async () => {
    const publishPost = vi.fn(async () => {
      throw new Error(IG_PUBLISH_190);
    });
    const refreshAccessToken = vi.fn(async () => {
      throw new Error(IG_DEAD_SESSION);
    });
    s.provider = realProvider("INSTAGRAM", { publishPost, refreshAccessToken });
    seedTarget("t1");

    const err = await runExpectingError(makeJob());

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe(`Token expired and refresh failed: ${IG_DEAD_SESSION}. Reconnect this channel in Settings.`);
    expect(rows.get("t1")).toMatchObject({ status: "FAILED", errorMessage: err.message, ambiguousAt: null });
    expect(publishPost).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("refresh failed with a NETWORK error → plain Error (BullMQ may retry)", async () => {
    s.provider = realProvider("INSTAGRAM", {
      publishPost: vi.fn(async () => {
        throw new Error(IG_PUBLISH_190);
      }),
      refreshAccessToken: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });
    seedTarget("t1");

    const err = await runExpectingError(makeJob());

    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("Token expired and refresh failed: fetch failed. Reconnect this channel in Settings.");
    expect(rows.get("t1")!.status).toBe("FAILED");
  });

  it("refresh SUCCEEDED but the re-publish failed → unchanged plain Error", async () => {
    const publishPost = vi.fn(async () => {
      throw new Error(IG_PUBLISH_190);
    });
    s.provider = realProvider("INSTAGRAM", {
      publishPost,
      refreshAccessToken: vi.fn(async () => ({ accessToken: "fresh" })),
    });
    seedTarget("t1");

    const err = await runExpectingError(makeJob());

    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(publishPost).toHaveBeenCalledTimes(2);
    expect(prisma.channel.update).toHaveBeenCalledTimes(1);
  });

  it("no refresh possible → judged on the ORIGINAL publish error", async () => {
    s.creds = null;
    s.provider = realProvider("INSTAGRAM", {
      publishPost: vi.fn(async () => {
        throw new Error(IG_PUBLISH_190);
      }),
    });
    seedTarget("t1");
    const definite = await runExpectingError(makeJob());
    expect(definite).toBeInstanceOf(UnrecoverableError);
    expect(s.provider.refreshAccessToken).not.toHaveBeenCalled();

    s.provider = realProvider("INSTAGRAM", {
      publishPost: vi.fn(async () => {
        throw new Error("Instagram publish failed: token expired (HTTP 502 from upstream)");
      }),
    });
    seedTarget("t1");
    const notDefinite = await runExpectingError(makeJob());
    expect(notDefinite).not.toBeInstanceOf(UnrecoverableError);
  });
});

describe("defers release the claim BEFORE re-queueing", () => {
  function hugeVideo() {
    return { media: { id: "v1", url: "https://cdn.example.com/v.mp4", fileType: "video/mp4", fileSize: 2 * 1024 ** 3, metadata: null } };
  }

  it("optimize wait: SCHEDULED is written first, then the delayed job is added", async () => {
    s.provider = realProvider("INSTAGRAM", {});
    seedPost([hugeVideo()]);
    seedTarget("t1");

    await expect(s.processor!(makeJob())).resolves.toBeUndefined();

    expect(rows.get("t1")).toMatchObject({ status: "SCHEDULED", errorMessage: OPTIMIZE_WAIT_MESSAGE });
    const scheduledWrite = prisma.postTarget.update.mock.calls.findIndex(([a]: any[]) => a.data.status === "SCHEDULED");
    const writeOrder = prisma.postTarget.update.mock.invocationCallOrder[scheduledWrite]!;
    expect(queue.postPublishQueue.add).toHaveBeenCalledTimes(1);
    expect(writeOrder).toBeLessThan(queue.postPublishQueue.add.mock.invocationCallOrder[0]!);
    const [, , opts] = queue.postPublishQueue.add.mock.calls[0] as any[];
    expect(opts).toMatchObject({ priority: 10, attempts: 3, backoff: { type: "exponential", delay: 60_000 } });
  });

  it("optimize wait: a failed add propagates and leaves the target SCHEDULED (re-claimable), not FAILED", async () => {
    s.provider = realProvider("INSTAGRAM", {});
    seedPost([hugeVideo()]);
    seedTarget("t1");
    queue.postPublishQueue.add.mockRejectedValue(new Error("Redis connection lost"));

    const err = await runExpectingError(makeJob());

    expect(err.message).toBe("Redis connection lost");
    expect(rows.get("t1")).toMatchObject({ status: "SCHEDULED", errorMessage: OPTIMIZE_WAIT_MESSAGE });
  });

  it("heavy-upload slot: SCHEDULED is written first; a failed add leaves it SCHEDULED", async () => {
    const gates = [deferred<any>(), deferred<any>(), deferred<any>()];
    let n = 0;
    const publishPost = vi.fn(() => gates[n++]!.promise);
    s.provider = {
      displayName: "YouTube",
      validateContent: () => [],
      publishPost,
      getPostAnalytics: vi.fn(async () => null),
    };
    seedChannel("YOUTUBE");
    seedPost([{ media: { id: "v1", url: "https://cdn.example.com/big.mp4", fileType: "video/mp4", fileSize: 400 * 1024 ** 2, metadata: null } }]);
    const yt = (id: string) => makeJob({ id: `job-${id}`, data: { ...makeJob().data, platform: "YOUTUBE", postTargetId: id } });
    for (const id of ["a", "b", "c", "d"]) seedTarget(id);

    const running = ["a", "b", "c"].map((id) => s.processor!(yt(id)));
    await vi.waitFor(() => expect(publishPost).toHaveBeenCalledTimes(3));

    queue.postPublishQueue.add.mockRejectedValueOnce(new Error("Redis connection lost"));
    const err = await runExpectingError(yt("d"));
    expect(err.message).toBe("Redis connection lost");
    expect(rows.get("d")).toMatchObject({ status: "SCHEDULED", errorMessage: "Waiting for a large-upload slot" });
    const scheduledWrite = prisma.postTarget.update.mock.calls.findIndex(
      ([a]: any[]) => a.where.id === "d" && a.data.status === "SCHEDULED"
    );
    expect(prisma.postTarget.update.mock.invocationCallOrder[scheduledWrite]!).toBeLessThan(
      queue.postPublishQueue.add.mock.invocationCallOrder[0]!
    );

    gates.forEach((g, i) => g.resolve({ platformPostId: `yt-${i}`, url: `https://youtu.be/${i}` }));
    await Promise.all(running);
    expect(["a", "b", "c"].map((id) => rows.get(id)!.status)).toEqual(["PUBLISHED", "PUBLISHED", "PUBLISHED"]);
  });
});

describe("timing log", () => {
  it("logs one [PublishTiming] line on success", async () => {
    s.provider = realProvider("INSTAGRAM", {
      publishPost: vi.fn(async () => ({ platformPostId: "ig-1", url: "https://instagram.com/p/1" })),
    });
    seedTarget("t1");
    const now = Date.now();

    await s.processor!(makeJob({ timestamp: now - 60_000, processedOn: now - 10_000, opts: { attempts: 3, delay: 20_000 } }));

    const lines = (console.log as any).mock.calls.map((c: any[]) => String(c[0])).filter((l: string) => l.startsWith("[PublishTiming]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[PublishTiming\] target=t1 platform=INSTAGRAM queueWaitMs=30000 runMs=\d+ sinceEnqueueMs=\d+$/);
  });
});

describe("wiring — the ordering the behaviour above depends on", () => {
  async function workerSource(): Promise<string> {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Comments stripped so an explanatory note cannot satisfy or break a check.
    return readFileSync(join(__dirname, "../workers/post-publish.worker.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("marks the job dispatched as the FIRST statement of the publish try — before the pre-flight and any publishPost", async () => {
    const src = await workerSource();
    expect(src.match(/state\.dispatched = true;/g)).toHaveLength(1);
    expect(src).toMatch(/if \(isHeavy\) heavyActive\+\+;\s*try \{\s*state\.dispatched = true;/);
    const dispatchedAt = src.indexOf("state.dispatched = true;");
    expect(dispatchedAt).toBeLessThan(src.indexOf("shouldPreflightReconcile("));
    expect(dispatchedAt).toBeLessThan(src.indexOf("provider.publishPost("));
    expect(dispatchedAt).toBeLessThan(src.indexOf("provider.findExistingPost!("));
  });

  it("claims exactly once, right after the claim-miss branch", async () => {
    const src = await workerSource();
    expect(src.match(/state\.claimed = true;/g)).toHaveLength(1);
    expect(src).toMatch(/return;\s*\}\s*state\.claimed = true;\s*addLocalClaim\(postTargetId\);/);
  });

  it("releases only for a claimed, undispatched job, and always rethrows the original error", async () => {
    const src = await workerSource();
    expect(src.match(/releaseClaimAfterPrePublishError\(/g)).toHaveLength(1);
    expect(src).toMatch(
      /catch \(err\) \{\s*if \(state\.claimed && !state\.dispatched\) \{\s*await releaseClaimAfterPrePublishError\(prisma, job\.data\.postTargetId, err\);\s*\}\s*throw err;\s*\}/
    );
  });

  it("the orphan release is conditional on the exact row it inspected", async () => {
    const src = await workerSource();
    expect(src).toMatch(
      /where: \{ id: postTargetId, status: "PUBLISHING", publishedId: null, updatedAt: current\.updatedAt \}/
    );
    expect(src.match(/throw new Error\(ORPHANED_CLAIM_MESSAGE\)/g)).toHaveLength(1);
  });

  it("the dead-token fast-fail keeps the ambiguity check first and only applies when the refresh did not succeed", async () => {
    const src = await workerSource();
    const tokenBranch = src.slice(src.indexOf('if (errType === "token_expired")'), src.indexOf('} else if (errType === "media_required")'));
    const ambiguous = tokenBranch.indexOf("isAmbiguousPublishError(refreshRetryErr)");
    const fastFail = tokenBranch.indexOf("isDefiniteAuthFailure(authEvidence)");
    expect(ambiguous).toBeGreaterThan(-1);
    expect(fastFail).toBeGreaterThan(ambiguous);
    expect(tokenBranch).toMatch(/if \(!refreshSucceeded && isDefiniteAuthFailure\(authEvidence\)\)/);
    expect(tokenBranch).toMatch(/refreshSucceeded = true;/);
  });
});
