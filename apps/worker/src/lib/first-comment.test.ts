import { describe, it, expect, vi } from "vitest";
import {
  postFirstComment,
  postScheduledFirstComment,
  abandonScheduledFirstComment,
  sweepFirstComments,
  STALE_POSTING_MESSAGE,
  type FirstCommentArgs,
} from "./first-comment";

const base: FirstCommentArgs = {
  platform: "INSTAGRAM",
  isStoryTarget: false,
  postMetadata: { instagramFirstComment: { text: "#love #travel" } },
  targetId: "t1",
  targetMetadata: {},
  mediaId: "17890000000000001",
  tokens: { accessToken: "TOKEN" },
};

const NOW = new Date("2026-10-17T10:00:00Z");

/** A fake $executeRaw: records the SQL and patch; claims succeed unless `claim` says otherwise. */
function deps(comment: (...a: any[]) => Promise<{ id: string }>, opts: { claim?: number } = {}) {
  const calls: { sql: string; patch: any }[] = [];
  return {
    calls,
    d: {
      prisma: {
        $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
          const sql = strings.join("?");
          calls.push({ sql, patch: JSON.parse(values[0]) });
          return /AND/.test(sql) ? (opts.claim ?? 1) : 1;
        }),
      },
      comment: vi.fn(comment),
      enqueueDelayed: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: () => NOW,
    },
  };
}

const finalWrites = (calls: { sql: string; patch: any }[]) => calls.filter((c) => !/AND/.test(c.sql)).map((c) => c.patch.firstComment);

describe("postFirstComment — immediate", () => {
  it("claims, posts the comment on the published media and records it (2026-10-17 shape)", async () => {
    const { d, calls } = deps(async () => ({ id: "c9" }));
    const r = await postFirstComment(d, base);
    expect(d.comment).toHaveBeenCalledWith("INSTAGRAM", { accessToken: "TOKEN" }, "17890000000000001", "#love #travel", undefined);
    expect(r).toEqual({ status: "posted", commentId: "c9", at: "2026-10-17T10:00:00.000Z" });
    // The claim comes first and only matches a row with no record yet.
    expect(calls[0]!.sql).toMatch(/"metadata"->'firstComment' IS NULL/);
    expect(calls[0]!.patch.firstComment.status).toBe("posting");
    expect(finalWrites(calls)).toEqual([r]);
  });

  it("posts nothing when another run already claimed the target", async () => {
    const { d } = deps(async () => ({ id: "c" }), { claim: 0 });
    expect(await postFirstComment(d, base)).toBeNull();
    expect(d.comment).not.toHaveBeenCalled();
  });

  it.each([
    ["a platform without comments", { platform: "TWITTER" }],
    ["Facebook with the legacy (Instagram-only) marker", { platform: "FACEBOOK" }],
    ["a story", { isStoryTarget: true }],
    ["no media id", { mediaId: null }],
    ["no first comment configured", { postMetadata: {} }],
    ["an outcome already recorded", { targetMetadata: { firstComment: { status: "unconfirmed", at: "x" } } }],
  ])("does nothing for %s", async (_l, over) => {
    const { d, calls } = deps(async () => ({ id: "c" }));
    expect(await postFirstComment(d, { ...base, ...(over as any) })).toBeNull();
    expect(d.comment).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("posts on Facebook as the Page with the new marker", async () => {
    const { d } = deps(async () => ({ id: "f1" }));
    const r = await postFirstComment(d, {
      ...base,
      platform: "FACEBOOK",
      mediaId: "111_222",
      pageId: "111",
      postMetadata: { firstComments: { comments: ["Link in bio"], delayMinutes: 0 } },
    });
    expect(d.comment).toHaveBeenCalledWith("FACEBOOK", { accessToken: "TOKEN" }, "111_222", "Link in bio", "111");
    expect(r?.status).toBe("posted");
  });

  it("posts several comments in order and records each", async () => {
    let n = 0;
    const { d } = deps(async () => ({ id: `c${++n}` }));
    const r = await postFirstComment(d, { ...base, postMetadata: { firstComments: { comments: ["one", "two", "three"] } } });
    expect(d.comment.mock.calls.map((c) => c[3])).toEqual(["one", "two", "three"]);
    expect(d.sleep).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: "posted", posted: 3, total: 3, commentId: "c1" });
    expect(r?.items?.map((i) => i.commentId)).toEqual(["c1", "c2", "c3"]);
  });

  it("stops at the first comment that does not post and skips the rest", async () => {
    let n = 0;
    const { d } = deps(async () => {
      if (++n === 2) throw new Error("Instagram accepted the comment but did not confirm it. … it may already be posted.");
      return { id: `c${n}` };
    });
    const r = await postFirstComment(d, { ...base, postMetadata: { firstComments: { comments: ["a", "b", "c"] } } });
    expect(d.comment).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: "unconfirmed", posted: 1, total: 3 });
    expect(r?.items?.map((i) => i.status)).toEqual(["posted", "unconfirmed", "skipped"]);
  });

  it("an unknown outcome is recorded as unconfirmed, never retried, never thrown", async () => {
    const { d } = deps(async () => {
      throw new Error("Instagram accepted the comment but did not confirm it. … it may already be posted.");
    });
    const r = await postFirstComment(d, base);
    expect(r?.status).toBe("unconfirmed");
    expect(d.comment).toHaveBeenCalledTimes(1);
  });

  it("a refusal is recorded as failed with the message", async () => {
    const { d } = deps(async () => {
      throw new Error("Instagram hasn't granted comment permission");
    });
    const r = await postFirstComment(d, base);
    expect(r).toMatchObject({ status: "failed", error: "Instagram hasn't granted comment permission" });
  });

  it("never throws; a failed claim posts nothing", async () => {
    const { d } = deps(async () => ({ id: "c" }));
    d.prisma.$executeRaw = vi.fn(async () => {
      throw new Error("db down");
    }) as any;
    await expect(postFirstComment(d, base)).resolves.toBeNull();
    expect(d.comment).not.toHaveBeenCalled();
  });

  it("never throws when only the final record fails to write", async () => {
    const { d } = deps(async () => ({ id: "c" }));
    let i = 0;
    d.prisma.$executeRaw = vi.fn(async () => {
      if (i++ === 0) return 1;
      throw new Error("db down");
    }) as any;
    await expect(postFirstComment(d, base)).resolves.toMatchObject({ status: "posted" });
  });
});

describe("postFirstComment — delayed", () => {
  const delayed = { ...base, postMetadata: { firstComments: { comments: ["later"], delayMinutes: 15 } } };

  it("records `scheduled` with the due time and queues the run instead of posting", async () => {
    const { d, calls } = deps(async () => ({ id: "c" }));
    const r = await postFirstComment(d, delayed);
    expect(r).toEqual({ status: "scheduled", at: NOW.toISOString(), dueAt: "2026-10-17T10:15:00.000Z" });
    expect(d.enqueueDelayed).toHaveBeenCalledWith("t1", 15 * 60_000);
    expect(d.comment).not.toHaveBeenCalled();
    expect(calls[0]!.sql).toMatch(/'firstComment' IS NULL/);
  });

  it("a scheduled record carries the comment count when there are several", async () => {
    const { d } = deps(async () => ({ id: "c" }));
    const r = await postFirstComment(d, { ...base, postMetadata: { firstComments: { comments: ["a", "b"], delayMinutes: 5 } } });
    expect(r).toMatchObject({ status: "scheduled", total: 2 });
  });

  it("a queue error leaves the `scheduled` record for the sweep and does not throw", async () => {
    const { d } = deps(async () => ({ id: "c" }));
    d.enqueueDelayed.mockRejectedValueOnce(new Error("redis down"));
    await expect(postFirstComment(d, delayed)).resolves.toMatchObject({ status: "scheduled" });
  });

  it("postScheduledFirstComment claims scheduled → posting before posting", async () => {
    const { d, calls } = deps(async () => ({ id: "c1" }));
    const r = await postScheduledFirstComment(d, { ...delayed, targetMetadata: null });
    expect(calls[0]!.sql).toMatch(/'firstComment'->>'status' = 'scheduled'/);
    expect(r).toMatchObject({ status: "posted", commentId: "c1" });
  });

  it("closes the record when the post no longer has first comments", async () => {
    const { d, calls } = deps(async () => ({ id: "c1" }));
    expect(await postScheduledFirstComment(d, { ...delayed, postMetadata: {}, targetMetadata: null })).toBeNull();
    expect(d.comment).not.toHaveBeenCalled();
    expect(calls[0]!.sql).toMatch(/'status' = 'scheduled'/);
    expect(calls[0]!.patch.firstComment.status).toBe("failed");
  });

  it("a duplicate delayed job that loses the claim posts nothing", async () => {
    const { d } = deps(async () => ({ id: "c1" }), { claim: 0 });
    expect(await postScheduledFirstComment(d, { ...delayed, targetMetadata: null })).toBeNull();
    expect(d.comment).not.toHaveBeenCalled();
  });

  it("abandonScheduledFirstComment only touches a scheduled record", async () => {
    const { d, calls } = deps(async () => ({ id: "c" }));
    expect(await abandonScheduledFirstComment(d.prisma, "t1", "Channel disconnected.", NOW)).toBe(true);
    expect(calls[0]!.sql).toMatch(/'status' = 'scheduled'/);
    expect(calls[0]!.patch.firstComment).toEqual({ status: "failed", error: "Channel disconnected.", at: NOW.toISOString() });
  });
});

describe("sweepFirstComments", () => {
  function sweepDeps(rows: { id: string; dueAt: string }[], stale = 0) {
    const executed: { sql: string; patch: any }[] = [];
    const requeue = vi.fn(async () => {});
    return {
      executed,
      requeue,
      d: {
        prisma: {
          $queryRaw: vi.fn(async () => rows),
          $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
            const sql = strings.join("?");
            executed.push({ sql, patch: JSON.parse(values[0]) });
            return /'posting'/.test(sql) ? stale : 1;
          }),
        },
        requeue,
        now: () => NOW,
      },
    };
  }

  it("re-queues overdue runs under a bucketed three-segment job id", async () => {
    const s = sweepDeps([{ id: "t1", dueAt: "2026-10-17T09:00:00Z" }]);
    const r = await sweepFirstComments(s.d);
    expect(r.requeued).toBe(1);
    const jobId = s.requeue.mock.calls[0]![1] as string;
    expect(jobId).toMatch(/^fcomment:t1:r\d+$/);
    expect(jobId.split(":")).toHaveLength(3);
  });

  it("abandons runs overdue by more than two days", async () => {
    const s = sweepDeps([{ id: "t1", dueAt: "2026-10-14T09:00:00Z" }]);
    const r = await sweepFirstComments(s.d);
    expect(r).toMatchObject({ requeued: 0, abandoned: 1 });
    expect(s.requeue).not.toHaveBeenCalled();
  });

  it("marks interrupted runs unconfirmed — never re-posts them", async () => {
    const s = sweepDeps([], 2);
    const r = await sweepFirstComments(s.d);
    expect(r.stale).toBe(2);
    const w = s.executed.find((e) => /'posting'/.test(e.sql))!;
    expect(w.patch.firstComment).toMatchObject({ status: "unconfirmed", error: STALE_POSTING_MESSAGE });
    expect(s.requeue).not.toHaveBeenCalled();
  });
});

describe("whole-column PostTarget.metadata writes after publish", () => {
  // The delayed first-comment job writes metadata.firstComment while these
  // workers hold an older copy of the row; a column rewrite would restore a
  // stale `scheduled` record and the sweep would post the comments again.
  it.each(["../workers/analytics-sync.worker.ts", "../workers/external-post-sync.worker.ts"])(
    "%s persists resolvedPostId with an atomic jsonb merge",
    (file) => {
      const src = require("node:fs").readFileSync(require("node:path").join(__dirname, file), "utf8");
      expect(src).toMatch(/JSON\.stringify\(\{ resolvedPostId: resolved \}\)/);
      expect(src).toMatch(/COALESCE\("metadata", '\{\}'::jsonb\) \|\| \$\{patch\}::jsonb/);
      expect(src).not.toMatch(/metadata: \{[^}]*resolvedPostId: resolved/);
    }
  );
});
