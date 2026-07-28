/**
 * super-text worker core (runSuperTextBurn + markSuperTextFailed).
 *
 * Follows the caption-fanout/sentiment-analysis pattern: the worker core is an
 * exported function, so these tests drive the REAL burn/swap/flip logic against
 * stateful in-memory mocks — no BullMQ instantiation.
 *
 * ffmpeg/ffprobe are mocked at the child_process boundary (the mocked "ffmpeg"
 * actually writes bytes to its output path, so the worker's real fs calls —
 * mkdtemp/stat/rm — run unmodified). Puppeteer, S3 and the queue are stubbed.
 *
 * Locked behaviors:
 *  - the burn creates a DERIVED Media row (stamped with sourceMediaId + a pending
 *    optimize state), enqueues the STANDARD optimize job, and repoints PostMedia
 *    at it — this is what lets the frozen IG/FB publish paths stay untouched;
 *  - the gate is cleared and the post flips DRAFT→SCHEDULED only when no other
 *    gate remains (a pending caption fanout defers the flip);
 *  - retry idempotency: an entry already marked done is never re-burned (the
 *    Media swap is not reversible);
 *  - a TRUNCATED encode throws instead of publishing a cut video, and the final
 *    retry marks the post FAILED (fail-visible — never publish un-burned);
 *  - markSuperTextFailed is idempotent;
 *  - a config for media that is no longer attached is skipped, not fatal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------- mocks

/**
 * Per-test knobs + shared mock fns. vi.mock factories are HOISTED above normal
 * const declarations, so anything they close over must come from vi.hoisted().
 */
const { ctl, s3Send, optimizeAdd, db } = vi.hoisted(() => ({
  ctl: {
    sourceDuration: 18.4,
    outputDuration: 18.3,
    sourceWidth: 720,
    sourceHeight: 1280,
    ffmpegCalls: 0,
    screenshotCalls: 0,
    evaluateArgs: [] as unknown[],
    evaluateThrows: false,
    fontActive: true as boolean | null,
  },
  s3Send: vi.fn(async (..._a: any[]) => ({})),
  optimizeAdd: vi.fn(async (..._a: any[]) => ({})),
  db: { state: null as any },
}));

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: any, cb: any) => {
    if (cmd === "ffprobe") {
      const target = args[args.length - 1]!;
      const isSource = target.startsWith("http");
      const duration = isSource ? ctl.sourceDuration : ctl.outputDuration;
      cb(null, {
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", width: ctl.sourceWidth, height: ctl.sourceHeight }],
          format: { duration: String(duration) },
        }),
        stderr: "",
      });
      return;
    }
    if (cmd === "ffmpeg") {
      ctl.ffmpegCalls++;
      // Simulate the encode: write real bytes at the output path (last arg) so
      // the worker's fsp.stat + createReadStream operate on a real file.
      writeFileSync(args[args.length - 1]!, Buffer.alloc(2048, 1));
      cb(null, { stdout: "", stderr: "" });
      return;
    }
    cb(new Error(`unexpected command ${cmd}`));
  },
}));

vi.mock("@postautomation/ai", () => ({
  launchCreativeBrowser: vi.fn(async () => ({
    newPage: async () => ({
      setViewport: vi.fn(async () => {}),
      setContent: vi.fn(async () => {}),
      // The font-readiness wait and the activation probe both go through
      // page.evaluate. Recording the args is how we prove the embedded-font path
      // is entered for `sans` and skipped entirely for `classic`.
      evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
        ctl.evaluateArgs.push(arg);
        if (ctl.evaluateThrows) throw new Error("Target closed: simulated CDP failure");
        // Stands in for document.fonts.check() — the activation probe.
        return ctl.fontActive;
      }),
      screenshot: vi.fn(async () => {
        ctl.screenshotCalls++;
        return Buffer.from("fake-png").toString("base64");
      }),
    }),
    close: vi.fn(async () => {}),
  })),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = s3Send;
  },
  PutObjectCommand: class {
    constructor(public input: any) {}
  },
}));

vi.mock("@postautomation/queue", () => ({
  QUEUE_NAMES: { SUPER_TEXT: "super-text" },
  mediaOptimizeQueue: { add: (...a: any[]) => optimizeAdd(...(a as [])) },
  createRedisConnection: vi.fn(() => ({})),
}));

/** Stateful prisma stand-in — updates mutate the fixture. */
vi.mock("@postautomation/db", () => ({
  prisma: {
    post: {
      findFirst: vi.fn(async (args: any) => {
        const p = db.state.post;
        if (args?.where?.id !== p.id) return null;
        if (args?.where?.organizationId && args.where.organizationId !== p.organizationId) return null;
        return p;
      }),
      findUnique: vi.fn(async (args: any) =>
        args.where.id === db.state.post.id ? { metadata: db.state.post.metadata } : null
      ),
      update: vi.fn(async (args: any) => {
        Object.assign(db.state.post, args.data);
        return db.state.post;
      }),
    },
    postTarget: {
      updateMany: vi.fn(async (args: any) => {
        let count = 0;
        const allowed: string[] | undefined = args.where?.status?.in;
        for (const t of db.state.post.targets) {
          const matches = allowed ? allowed.includes(t.status) : t.status === args.where?.status;
          if (matches) {
            Object.assign(t, args.data);
            count++;
          }
        }
        return { count };
      }),
    },
    postMedia: {
      updateMany: vi.fn(async (args: any) => {
        db.state.postMediaSwaps.push({ from: args.where.mediaId, to: args.data.mediaId });
        return { count: 1 };
      }),
    },
    media: {
      create: vi.fn(async (args: any) => {
        const row = { id: `derived-${db.state.mediaCreates.length + 1}`, ...args.data };
        db.state.mediaCreates.push(row);
        return row;
      }),
    },
  },
}));

import { runSuperTextBurn, markSuperTextFailed, SUPER_TEXT_FAIL_MESSAGE } from "../super-text.worker";

// ---------------------------------------------------------------- fixtures

const cfg = {
  version: 1,
  segments: [{ text: "Ranveer" }, { text: "Yalina😍", color: "#EF4444" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

function seed(opts: {
  superText?: Record<string, any>;
  captionPending?: boolean;
  attachedVideo?: boolean;
  status?: string;
} = {}) {
  const {
    superText = { requested: true, pendingBurn: true, parkedSchedule: true, byMediaId: { "media-1": cfg } },
    captionPending = false,
    attachedVideo = true,
    status = "DRAFT",
  } = opts;

  db.state = {
    post: {
      id: "post-1",
      organizationId: "org-1",
      createdById: "user-1",
      status,
      scheduledAt: new Date("2099-01-01T10:00:00.000Z"),
      metadata: {
        superText,
        ...(captionPending ? { captionFanout: { requested: true, pendingSchedule: true } } : {}),
      },
      targets: [
        { id: "t1", status: "DRAFT" },
        { id: "t2", status: "DRAFT" },
      ],
      mediaAttachments: attachedVideo
        ? [
            {
              mediaId: "media-1",
              media: {
                id: "media-1",
                url: "https://s3.example.com/videos/original.mp4",
                fileName: "original.mp4",
                fileType: "video/mp4",
                fileSize: BigInt(5_000_000),
                duration: 18,
              },
            },
          ]
        : [],
      postMediaSwaps: [],
    },
    mediaCreates: [] as any[],
    postMediaSwaps: [] as any[],
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  ctl.sourceDuration = 18.4;
  ctl.outputDuration = 18.3;
  ctl.sourceWidth = 720;
  ctl.sourceHeight = 1280;
  ctl.ffmpegCalls = 0;
  ctl.screenshotCalls = 0;
  ctl.evaluateArgs = [];
  ctl.evaluateThrows = false;
  ctl.fontActive = true;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // downloadToFile streams a real (tiny) body to disk.
  global.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))) as any;
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------- tests

describe("runSuperTextBurn — happy path", () => {
  it("derives a Media row, enqueues optimize, swaps the attachment, clears the gate and flips", async () => {
    seed();
    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })) as any;

    expect(res.burned).toBe(1);
    expect(ctl.screenshotCalls).toBe(1); // strip rendered once
    expect(ctl.ffmpegCalls).toBe(1); // composited once

    // A DERIVED Media row, traceable to its source and handed to the STANDARD
    // optimize pipeline — this is what keeps the publish paths unchanged.
    const derived = db.state.mediaCreates[0];
    expect(derived.fileType).toBe("video/mp4");
    expect(derived.organizationId).toBe("org-1");
    expect(derived.metadata.superText.sourceMediaId).toBe("media-1");
    expect(derived.metadata.optimize.status).toBe("pending");
    expect(derived.width).toBe(720);
    expect(derived.height).toBe(1280);

    // Uploaded, then the standard optimize job with a 3-segment jobId.
    expect(s3Send).toHaveBeenCalledTimes(1);
    const jobId = optimizeAdd.mock.calls[0]![2].jobId as string;
    expect(jobId).toBe(`optimize:${derived.id}:v1`);
    expect(jobId.split(":")).toHaveLength(3);

    // The post now points at the burned video, not the original.
    expect(db.state.postMediaSwaps).toEqual([{ from: "media-1", to: derived.id }]);

    // Gate cleared and the post released to the publish cron.
    expect(db.state.post.metadata.superText.pendingBurn).toBe(false);
    expect(res.flipped).toBe(true);
    expect(db.state.post.status).toBe("SCHEDULED");
    expect(db.state.post.targets.every((t: any) => t.status === "SCHEDULED")).toBe(true);
  });

  it("uploads to an org-scoped, config-hashed key so an edited strip never reuses a stale object", async () => {
    seed();
    await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" });
    const key = (s3Send.mock.calls[0]![0] as any).input.Key as string;
    expect(key).toMatch(/^supertext\/org-1\/media-1-[0-9a-f]{8}\.mp4$/);
  });
});

describe("runSuperTextBurn — gate coordination", () => {
  it("clears its own gate but does NOT flip while captions are still pending", async () => {
    seed({ captionPending: true });
    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })) as any;

    expect(res.burned).toBe(1);
    expect(db.state.post.metadata.superText.pendingBurn).toBe(false);
    expect(res.flipped).toBe(false);
    expect(db.state.post.status).toBe("DRAFT");
  });
});

describe("runSuperTextBurn — embedded font path", () => {
  /**
   * Before these, EVERY worker test used a font-less config, so `embeddedFamily`
   * was always null and the whole font-readiness branch was unexercised — a
   * "simplification" of the resolveSuperTextFont guard would have failed no test
   * and silently produced fallback-face burns.
   */
  it("skips the font wait entirely for a font-less (classic) config", async () => {
    seed();
    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })) as any;
    expect(res.burned).toBe(1);
    // No evaluate at all: no readiness wait, no activation probe.
    expect(ctl.evaluateArgs).toEqual([]);
  });

  it("awaits the embedded family and probes activation for font:'sans'", async () => {
    seed({
      superText: {
        requested: true,
        pendingBurn: true,
        parkedSchedule: true,
        byMediaId: { "media-1": { ...cfg, font: "sans" } },
      },
    });

    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })) as any;

    expect(res.burned).toBe(1);
    // Both the readiness wait and the activation probe are passed the family.
    expect(ctl.evaluateArgs).toEqual(["PA Display Sans", "PA Display Sans"]);
    expect(ctl.screenshotCalls).toBe(1);
  });

  it("warns but still burns when the embedded face did not activate", async () => {
    ctl.fontActive = false; // document.fonts.check() === false
    seed({
      superText: {
        requested: true,
        pendingBurn: true,
        parkedSchedule: true,
        byMediaId: { "media-1": { ...cfg, font: "sans" } },
      },
    });

    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })) as any;

    // A wrong FACE is cosmetic — the video is valid, so this must not fail the
    // burn. But it must be diagnosable rather than silent.
    expect(res.burned).toBe(1);
    expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/did NOT activate/i);
  });

  it("a CDP failure during the font wait can never fail an otherwise-good burn", async () => {
    // Before this feature there was no page.evaluate here at all, so letting a
    // rejection escape would have been a brand-new failure mode for every
    // super-text post — and super text is FAIL-VISIBLE, so it would mark the post
    // and all its targets FAILED.
    ctl.evaluateThrows = true;
    seed({
      superText: {
        requested: true,
        pendingBurn: true,
        parkedSchedule: true,
        byMediaId: { "media-1": { ...cfg, font: "sans" } },
      },
    });

    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })) as any;

    expect(res.burned).toBe(1);
    expect(ctl.screenshotCalls).toBe(1);
    expect(db.state.post.targets.every((t: any) => t.status !== "FAILED")).toBe(true);
  });
});

describe("runSuperTextBurn — idempotency & skips", () => {
  it("never re-burns an entry already marked done (the Media swap is irreversible)", async () => {
    seed({
      superText: {
        requested: true,
        pendingBurn: true,
        parkedSchedule: true,
        byMediaId: { "media-1": cfg },
        results: { "media-1": { status: "done", derivedMediaId: "derived-earlier" } },
      },
    });

    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })) as any;

    expect(res.burned).toBe(0);
    expect(res.skipped).toBe(1);
    expect(ctl.ffmpegCalls).toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
    expect(db.state.mediaCreates).toHaveLength(0);
    expect(db.state.postMediaSwaps).toHaveLength(0);
    // Still resolves the gate so the post is not stranded.
    expect(db.state.post.metadata.superText.pendingBurn).toBe(false);
  });

  it("skips a config whose media is no longer attached — not fatal", async () => {
    seed({ attachedVideo: false });
    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })) as any;

    expect(res.burned).toBe(0);
    expect(res.skipped).toBe(1);
    expect(db.state.post.metadata.superText.pendingBurn).toBe(false);
    expect(res.flipped).toBe(true); // nothing to burn → release the post
  });

  it("no-ops when the gate is already cleared (a duplicate job)", async () => {
    seed({ superText: { requested: true, pendingBurn: false, byMediaId: { "media-1": cfg } } });
    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })) as any;
    expect(res).toEqual({ skipped: "not_pending" });
    expect(ctl.ffmpegCalls).toBe(0);
  });

  it("is org-scoped: a foreign organizationId never touches the post", async () => {
    seed();
    const res = (await runSuperTextBurn({ postId: "post-1", organizationId: "other-org" })) as any;
    expect(res).toEqual({ skipped: "post_not_found" });
    expect(ctl.ffmpegCalls).toBe(0);
  });
});

describe("runSuperTextBurn — truncated output is fatal (never publish a cut video)", () => {
  it("throws when the encode comes back short", async () => {
    seed();
    ctl.sourceDuration = 63;
    ctl.outputDuration = 40; // stalled encode that still exited 0

    await expect(runSuperTextBurn({ postId: "post-1", organizationId: "org-1" })).rejects.toThrow(
      /truncated/i
    );
    // The post must NOT have been swapped or released.
    expect(db.state.postMediaSwaps).toHaveLength(0);
    expect(db.state.post.status).toBe("DRAFT");
  });
});

describe("markSuperTextFailed — fail-visible", () => {
  it("marks the post and its non-terminal targets FAILED with an actionable message", async () => {
    seed();
    await markSuperTextFailed("post-1", "org-1", "ffmpeg exploded");

    expect(db.state.post.status).toBe("FAILED");
    expect(db.state.post.targets.every((t: any) => t.status === "FAILED")).toBe(true);
    expect(db.state.post.targets[0].errorMessage).toBe(SUPER_TEXT_FAIL_MESSAGE);
    expect(db.state.post.metadata.superText.failed).toBe(true);
    expect(db.state.post.metadata.superText.pendingBurn).toBe(false);
    expect(db.state.post.metadata.superText.error).toContain("ffmpeg exploded");
  });

  it("is idempotent — a post whose gate is already resolved is left alone", async () => {
    seed({ superText: { requested: true, pendingBurn: false, byMediaId: {} }, status: "SCHEDULED" });
    await markSuperTextFailed("post-1", "org-1", "late failure");
    expect(db.state.post.status).toBe("SCHEDULED");
  });

  it("is org-scoped", async () => {
    seed();
    await markSuperTextFailed("post-1", "other-org", "nope");
    expect(db.state.post.status).toBe("DRAFT");
  });
});
