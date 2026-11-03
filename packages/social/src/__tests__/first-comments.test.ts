import { describe, it, expect, vi, afterEach } from "vitest";
import {
  readFirstCommentsPlan,
  readFirstCommentRecord,
  summarizeFirstComments,
  firstCommentJobId,
  FIRST_COMMENT_PLATFORMS,
} from "../utils/first-comments";
import { FacebookProvider } from "../providers/facebook.provider";
import {
  FB_COMMENT_CREATE_FAILED_MESSAGE,
  FB_COMMENT_CREATE_UNCONFIRMED_MESSAGE,
  FB_COMMENT_POST_GONE_MESSAGE,
} from "../utils/facebook-comments";

/** Several first comments, Facebook Pages and a delay (2026-11-03). */
describe("readFirstCommentsPlan", () => {
  it("reads the new marker for Instagram and Facebook", () => {
    expect(readFirstCommentsPlan({ firstComments: { comments: [" #a ", "two"], delayMinutes: 15 } })).toEqual({
      comments: ["#a", "two"],
      delayMinutes: 15,
      platforms: FIRST_COMMENT_PLATFORMS,
    });
    expect(FIRST_COMMENT_PLATFORMS).toEqual(["INSTAGRAM", "FACEBOOK"]);
  });

  it("still reads the 2026-10-17 marker: Instagram only, immediately", () => {
    expect(readFirstCommentsPlan({ instagramFirstComment: { text: " #tags " } })).toEqual({
      comments: ["#tags"],
      delayMinutes: 0,
      platforms: ["INSTAGRAM"],
    });
  });

  it.each([
    ["nothing", {}],
    ["null", null],
    ["no comments", { firstComments: { comments: [] } }],
    ["a blank comment", { firstComments: { comments: ["ok", "  "] } }],
    ["too long", { firstComments: { comments: ["x".repeat(2201)] } }],
    ["more than five", { firstComments: { comments: ["1", "2", "3", "4", "5", "6"] } }],
    ["a negative delay", { firstComments: { comments: ["a"], delayMinutes: -1 } }],
    ["a delay over a day", { firstComments: { comments: ["a"], delayMinutes: 1441 } }],
    ["a fractional delay", { firstComments: { comments: ["a"], delayMinutes: 1.5 } }],
  ])("reads %s as no plan", (_l, md) => {
    expect(readFirstCommentsPlan(md)).toBeNull();
  });
});

describe("summarizeFirstComments", () => {
  it("keeps the single-comment record shape unchanged", () => {
    expect(summarizeFirstComments([{ status: "posted", commentId: "9" }], "t")).toEqual({ status: "posted", commentId: "9", at: "t" });
    expect(summarizeFirstComments([{ status: "failed", error: "no" }], "t")).toEqual({ status: "failed", error: "no", at: "t" });
  });

  it("counts several comments; an unknown outcome outranks a refusal", () => {
    expect(
      summarizeFirstComments([{ status: "posted", commentId: "1" }, { status: "unconfirmed", error: "may already be posted" }, { status: "skipped" }], "t")
    ).toMatchObject({ status: "unconfirmed", posted: 1, total: 3, commentId: "1", error: "may already be posted" });
    expect(summarizeFirstComments([{ status: "failed", error: "x" }, { status: "skipped" }], "t")).toMatchObject({
      status: "failed",
      posted: 0,
      total: 2,
    });
  });
});

describe("readFirstCommentRecord", () => {
  it("reads the scheduled and multi-comment shapes", () => {
    expect(readFirstCommentRecord({ firstComment: { status: "scheduled", at: "a", dueAt: "b" } })).toEqual({
      status: "scheduled",
      at: "a",
      dueAt: "b",
      commentId: undefined,
      error: undefined,
    });
    const r = readFirstCommentRecord({
      firstComment: { status: "posted", at: "a", posted: 2, total: 2, items: [{ status: "posted", commentId: "1" }, { status: "bogus" }] },
    });
    expect(r).toMatchObject({ posted: 2, total: 2, items: [{ status: "posted", commentId: "1" }] });
  });
});

it("the delayed job id has exactly three colon segments", () => {
  expect(firstCommentJobId("cmabc").split(":")).toEqual(["fcomment", "cmabc", "v1"]);
});

describe("FacebookProvider.commentOnPost", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(reply: { ok: boolean; status?: number; body?: any; throws?: Error }) {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: any) => {
        calls.push({ url: String(url), init });
        if (reply.throws) throw reply.throws;
        const res: any = {
          ok: reply.ok,
          status: reply.status ?? (reply.ok ? 200 : 400),
          json: async () => reply.body,
          headers: { get: () => null },
        };
        res.clone = () => res;
        return res;
      })
    );
    return calls;
  }

  const fb = () => new FacebookProvider();
  const tokens = { accessToken: "PAGE_TOKEN" };

  it("POSTs a top-level comment on the post as the Page, token in the body", async () => {
    const calls = stub({ ok: true, body: { id: "222_9" } });
    expect(await fb().commentOnPost(tokens, "111_222", "Link in bio", "111")).toEqual({ id: "222_9" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/111_222\/comments$/);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ message: "Link in bio", access_token: "PAGE_TOKEN" });
  });

  it("refuses an object id that is not a Graph id, without calling Graph", async () => {
    const calls = stub({ ok: true, body: { id: "x" } });
    await expect(fb().commentOnPost(tokens, "111/feed?x=", "hi", "111")).rejects.toThrow(FB_COMMENT_CREATE_FAILED_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a 5xx", { ok: false, status: 500, body: { error: { code: 1, message: "unknown" } } }],
    ["a transient 4xx", { ok: false, status: 400, body: { error: { code: 2, is_transient: true, message: "temp" } } }],
    ["an OK body without an id", { ok: true, body: {} }],
    ["a request that never completed", { ok: false, throws: new Error("socket hang up") }],
  ])("%s reads as 'may already be posted', never as a failure", async (_l, reply) => {
    stub(reply as any);
    await expect(fb().commentOnPost(tokens, "111_222", "hi", "111")).rejects.toThrow(FB_COMMENT_CREATE_UNCONFIRMED_MESSAGE);
    expect(FB_COMMENT_CREATE_UNCONFIRMED_MESSAGE).toMatch(/may already be posted/);
  });

  it("a deleted post says so", async () => {
    stub({ ok: false, status: 400, body: { error: { code: 100, error_subcode: 33, message: "Unsupported post request. Object with ID '111_222' does not exist" } } });
    await expect(fb().commentOnPost(tokens, "111_222", "hi", "111")).rejects.toThrow(FB_COMMENT_POST_GONE_MESSAGE);
  });

  it("a plain refusal reads as a comment failure, not a reply failure", async () => {
    stub({ ok: false, status: 400, body: { error: { code: 1, message: "An unknown error occurred" } } });
    await expect(fb().commentOnPost(tokens, "111_222", "hi", "111")).rejects.toThrow(FB_COMMENT_CREATE_FAILED_MESSAGE);
  });
});
