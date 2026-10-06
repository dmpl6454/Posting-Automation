import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  __resetExternalSweepState,
  classifyLinkedInRead,
  linkedinOrgUrn,
  readLinkedInSentimentConfig,
  runCommentSweep,
  type SweepConfig,
} from "./comment-sweep";
import { linkedinSentimentCandidates } from "./comment-sentiment";

/**
 * LinkedIn Page comment sentiment (2026-10-06): the comment sweep reads
 * `socialActions/{post}/comments` on posts the app published to LinkedIn
 * PAGES — sentiment only, under its own daily call cap. Response shapes follow
 * LinkedIn's documented Comments API (versioned REST).
 */

const CFG: SweepConfig = { maxPostsPerRun: 40, maxPostsPerOrg: 15, lookbackDays: 3, fbUsageCeiling: 75, maxHidesPerOrg: 50 };
const LI_CFG = { dailyUnits: 300, maxPostsPerRun: 20, minIntervalMs: 60 * 60 * 1000, lookbackDays: 7 };
const NOW = new Date("2026-10-06T12:00:00Z");
const ORG = "urn:li:organization:777";
const POST_A = "urn:li:share:7380000000000000001";
const POST_B = "urn:li:ugcPost:7380000000000000002";

const el = (n: number, text: string, over: Record<string, unknown> = {}) => ({
  actor: `urn:li:person:p${n}`,
  commentUrn: `urn:li:comment:(urn:li:activity:900,${n})`,
  id: String(n),
  object: "urn:li:activity:900",
  created: { actor: `urn:li:person:p${n}`, time: Date.parse("2026-10-06T10:00:00Z") + n * 1000 },
  message: { text, attributes: [] },
  likesSummary: { totalLikes: 0 },
  ...over,
});
const page = (elements: any[], total = elements.length, start = 0) => ({ paging: { start, count: 50, total, links: [] }, elements });

describe("linkedinSentimentCandidates", () => {
  it("keeps members' comments and replies, skips the Page's own and empty ones", () => {
    const out = linkedinSentimentCandidates(
      page([
        el(1, "Great hire, congrats!"),
        el(2, "Thanks everyone", { actor: ORG }),
        el(3, "   "),
        el(4, "Agreed", { parentComment: "urn:li:comment:(urn:li:activity:900,1)" }),
        el(5, "From another company", { actor: "urn:li:organization:42" }),
        { id: "6", object: "urn:li:activity:900", actor: "urn:li:person:x", message: { text: "no urn, no time" } },
        { message: { text: "no id at all" } },
      ]),
      ORG
    );
    expect(out).toEqual([
      { commentId: "urn:li:comment:(urn:li:activity:900,1)", commentText: "Great hire, congrats!", authorLabel: "LinkedIn member", isReply: false, commentedAt: new Date("2026-10-06T10:00:01Z") },
      { commentId: "urn:li:comment:(urn:li:activity:900,4)", commentText: "Agreed", authorLabel: "LinkedIn member", isReply: true, commentedAt: new Date("2026-10-06T10:00:04Z") },
      { commentId: "urn:li:comment:(urn:li:activity:900,5)", commentText: "From another company", authorLabel: "LinkedIn Page", isReply: false, commentedAt: new Date("2026-10-06T10:00:05Z") },
      { commentId: "urn:li:comment:(urn:li:activity:900,6)", commentText: "no urn, no time", authorLabel: "LinkedIn member", isReply: false, commentedAt: null },
    ]);
    expect(linkedinSentimentCandidates(null, ORG)).toEqual([]);
    expect(linkedinSentimentCandidates({ status: 403 }, ORG)).toEqual([]);
  });
});

describe("LinkedIn helpers", () => {
  it("the Page's organization URN comes from metadata.orgId or the org- platform id", () => {
    expect(linkedinOrgUrn({ platformId: "org-777", metadata: { orgId: "777" } })).toBe(ORG);
    expect(linkedinOrgUrn({ platformId: "org-777", metadata: null })).toBe(ORG);
    expect(linkedinOrgUrn({ platformId: "abcPERSON", metadata: null })).toBeNull();
  });

  it("classifies responses: a DAY throttle stops for the day, any other 429 for the run", () => {
    expect(classifyLinkedInRead({ status: 429, body: { message: "Resource level throttle APPLICATION DAY limit for calls to this resource is reached." } })).toEqual({ kind: "quotaExhausted" });
    expect(classifyLinkedInRead({ status: 429, body: { message: "Too many requests" } })).toEqual({ kind: "rateLimited" });
    expect(classifyLinkedInRead({ status: 401, body: null })).toEqual({ kind: "tokenRefused" });
    expect(classifyLinkedInRead({ status: 403, body: { code: "ACCESS_DENIED" } })).toEqual({ kind: "scopeMissing" });
    expect(classifyLinkedInRead({ status: 404, body: null })).toEqual({ kind: "postState" });
    expect(classifyLinkedInRead({ status: 200, body: page([]) })).toEqual({ kind: "ok", found: [] });
    expect(classifyLinkedInRead({ status: 500, body: { serviceErrorCode: 65600 } })).toEqual({ kind: "failed", detail: "HTTP 500 65600" });
  });

  it("config: defaults, clamps, and compose's empty string means default", () => {
    expect(readLinkedInSentimentConfig({})).toEqual(LI_CFG);
    expect(readLinkedInSentimentConfig({ COMMENT_SENTIMENT_LI_DAILY_CALLS: "" }).dailyUnits).toBe(300);
    expect(readLinkedInSentimentConfig({ COMMENT_SENTIMENT_LI_DAILY_CALLS: "0" }).dailyUnits).toBe(0);
    expect(readLinkedInSentimentConfig({ COMMENT_SENTIMENT_LI_MAX_POSTS: "999" }).maxPostsPerRun).toBe(200);
  });
});

// ── the LinkedIn pass of runCommentSweep ────────────────────────────────────

const PAGE_CH = {
  id: "ch-li", organizationId: "org-1", platform: "LINKEDIN", platformId: "org-777", name: "Acme (Page)",
  accessToken: "DECRYPTED_LI", tokenExpiresAt: new Date("2026-11-30T00:00:00Z"),
  scopes: ["openid", "profile", "w_member_social", "w_organization_social", "r_organization_social"], metadata: { orgId: "777" },
};
const liTarget = (id: string, publishedId: string, checkedAt?: number) => ({
  id, channelId: "ch-li", publishedId, publishedAt: new Date("2026-10-05T08:00:00Z"),
  metadata: checkedAt !== undefined ? { commentSweep: { checkedAt } } : null,
});

function setup(opts: { liTargets?: any[]; channels?: any[]; existing?: string[]; sentimentEnabled?: boolean } = {}) {
  const created: any[] = [];
  const executeRaw: any[] = [];
  const automation = {
    id: "auto", organizationId: "org-1", autoHideEnabled: false, alertsEnabled: true, sentimentEnabled: opts.sentimentEnabled ?? true,
    blockedWords: [], hideLinks: false, channelIds: [],
  };
  const prisma = {
    commentAutomation: { findMany: vi.fn(async () => [automation]), update: vi.fn(async () => ({})) },
    postTarget: { findMany: vi.fn(async (a: any) => (a.where.channel.platform === "LINKEDIN" ? (opts.liTargets ?? []) : [])) },
    channel: { findMany: vi.fn(async () => opts.channels ?? [PAGE_CH]) },
    commentAutoAction: { findMany: vi.fn(async () => []), create: vi.fn() },
    commentSentiment: {
      findMany: vi.fn(async (a: any) =>
        a.where.commentId ? (opts.existing ?? []).filter((id) => a.where.commentId.in.includes(id)).map((commentId) => ({ commentId })) : []
      ),
      createMany: vi.fn(async (a: any) => created.push(...a.data)),
      update: vi.fn(),
      count: vi.fn(async () => 0),
    },
    notification: { findFirst: vi.fn(async () => null), create: vi.fn() },
    organizationMember: { findMany: vi.fn(async () => [{ userId: "owner" }]) },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => executeRaw.push({ sql: strings.join("?"), values })),
  };
  const responses: Record<string, (start: number) => { status: number; body: unknown }> = {};
  const readLinkedInComments = vi.fn(async (_t: string, urn: string, start: number, _count: number) =>
    responses[urn] ? responses[urn]!(start) : { status: 200, body: page([]) }
  );
  const reserveLinkedInCalls = vi.fn(async (_n: number) => true);
  const deps = {
    prisma, readComments: vi.fn(), hideComment: vi.fn(), facebookUsagePeak: () => 0, now: () => NOW,
    log: { log: vi.fn(), warn: vi.fn() },
    readLinkedInComments, reserveLinkedInCalls, linkedinConfig: LI_CFG,
  };
  return { prisma, deps, responses, created, executeRaw, readLinkedInComments, reserveLinkedInCalls };
}

describe("runCommentSweep — LinkedIn Page comment sentiment", () => {
  beforeEach(() => __resetExternalSweepState());

  it("queries only the workspace's LinkedIn PAGE channels (never personal profiles)", async () => {
    const { prisma, deps } = setup();
    await runCommentSweep(deps as any, CFG);
    const call = prisma.postTarget.findMany.mock.calls.find((c: any) => c[0].where.channel.platform === "LINKEDIN")![0] as any;
    expect(call.where.channel).toEqual({
      organizationId: "org-1", disconnectedAt: null, isActive: true, platform: "LINKEDIN", platformId: { startsWith: "org-" },
    });
    expect(call.where.publishedAt.gte.toISOString()).toBe("2026-09-29T12:00:00.000Z");
  });

  it("reads the first page with the Page's token, stores new comments as LINKEDIN, stamps the post", async () => {
    const { deps, responses, created, executeRaw, readLinkedInComments } = setup({ liTargets: [liTarget("t1", POST_A)], existing: ["urn:li:comment:(urn:li:activity:900,1)"] });
    responses[POST_A] = () => ({ status: 200, body: page([el(1, "seen"), el(2, "Love this update"), el(3, "us", { actor: ORG })]) });
    const res = await runCommentSweep(deps as any, CFG);
    expect(readLinkedInComments).toHaveBeenCalledWith("DECRYPTED_LI", POST_A, 0, 50);
    expect(created).toEqual([
      expect.objectContaining({ platform: "LINKEDIN", channelId: "ch-li", postTargetId: "t1", commentId: "urn:li:comment:(urn:li:activity:900,2)", authorLabel: "LinkedIn member" }),
    ]);
    expect(res["org-1"]).toMatchObject({ linkedinPostsChecked: 1, sentimentStored: 1, errors: 0, newComments: 0 });
    expect(JSON.parse(executeRaw.find((e) => e.values.includes("t1")).values[0])).toEqual({ commentSweep: { checkedAt: NOW.getTime() } });
  });

  it("a post with more than one page also reads the last page (newest end, whatever the order)", async () => {
    const { deps, responses, created, readLinkedInComments, reserveLinkedInCalls } = setup({ liTargets: [liTarget("t1", POST_A)] });
    responses[POST_A] = (start) =>
      start === 0
        ? { status: 200, body: page([el(1, "first"), el(2, "second")], 120) }
        : { status: 200, body: page([el(2, "second"), el(120, "newest")], 120, start) };
    await runCommentSweep(deps as any, CFG);
    expect(readLinkedInComments.mock.calls.map((c) => c[2])).toEqual([0, 70]);
    expect(reserveLinkedInCalls).toHaveBeenCalledTimes(2);
    expect(created.map((c) => c.commentText)).toEqual(["first", "second", "newest"]);
  });

  it("when the cap allows only the first call, the first page is still stored", async () => {
    const { deps, responses, created, readLinkedInComments, reserveLinkedInCalls } = setup({ liTargets: [liTarget("t1", POST_A)] });
    reserveLinkedInCalls.mockResolvedValueOnce(true).mockResolvedValue(false);
    responses[POST_A] = () => ({ status: 200, body: page([el(1, "first")], 120) });
    await runCommentSweep(deps as any, CFG);
    expect(readLinkedInComments).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("skips non-post ids and recently read posts; a Page whose recorded grant lacks r_organization_social costs nothing", async () => {
    const a = setup({ liTargets: [liTarget("bad", ""), liTarget("fresh", POST_A, NOW.getTime() - 5 * 60 * 1000), liTarget("due", POST_B)] });
    await runCommentSweep(a.deps as any, CFG);
    expect(a.readLinkedInComments.mock.calls.map((c) => c[1])).toEqual([POST_B]);

    const b = setup({ liTargets: [liTarget("t1", POST_A)], channels: [{ ...PAGE_CH, scopes: ["openid", "profile", "w_organization_social"] }] });
    await runCommentSweep(b.deps as any, CFG);
    expect(b.reserveLinkedInCalls).not.toHaveBeenCalled();
    expect(b.readLinkedInComments).not.toHaveBeenCalled();
  });

  it("403 parks the Page for a day; LinkedIn's DAY throttle stops LinkedIn until the UTC day turns", async () => {
    const a = setup({ liTargets: [liTarget("t1", POST_A), liTarget("t2", POST_B)] });
    a.responses[POST_A] = () => ({ status: 403, body: { status: 403, code: "ACCESS_DENIED" } });
    const res = await runCommentSweep(a.deps as any, CFG);
    expect(a.readLinkedInComments).toHaveBeenCalledTimes(1);
    expect(res["org-1"]).toMatchObject({ errors: 1 });
    await runCommentSweep(a.deps as any, CFG);
    expect(a.readLinkedInComments).toHaveBeenCalledTimes(1);

    __resetExternalSweepState();
    const b = setup({ liTargets: [liTarget("t1", POST_A), liTarget("t2", POST_B)] });
    b.responses[POST_A] = () => ({ status: 429, body: { message: "Resource level throttle APPLICATION DAY limit for calls to this resource is reached." } });
    await runCommentSweep(b.deps as any, CFG);
    expect(b.readLinkedInComments).toHaveBeenCalledTimes(1);
    expect(b.executeRaw).toEqual([]);
    await runCommentSweep(b.deps as any, CFG);
    expect(b.readLinkedInComments).toHaveBeenCalledTimes(1);
    await runCommentSweep({ ...b.deps, now: () => new Date("2026-10-07T00:05:00Z") } as any, CFG);
    expect(b.readLinkedInComments).toHaveBeenCalledTimes(2);
  });

  it("a deleted post is its state, not an error; nothing runs without sentiment on", async () => {
    const a = setup({ liTargets: [liTarget("t1", POST_A)] });
    a.responses[POST_A] = () => ({ status: 404, body: null });
    const res = await runCommentSweep(a.deps as any, CFG);
    expect(res["org-1"]).toMatchObject({ errors: 0, linkedinPostsChecked: 1 });

    const off = setup({ liTargets: [liTarget("t1", POST_A)], sentimentEnabled: false });
    await runCommentSweep(off.deps as any, CFG);
    expect(off.readLinkedInComments).not.toHaveBeenCalled();
  });

  it("never reads a channel belonging to another workspace, or a personal profile channel", async () => {
    const a = setup({ liTargets: [liTarget("t1", POST_A)], channels: [{ ...PAGE_CH, organizationId: "org-2" }] });
    await runCommentSweep(a.deps as any, CFG);
    expect(a.readLinkedInComments).not.toHaveBeenCalled();

    const personal = setup({ liTargets: [liTarget("t1", POST_A)], channels: [{ ...PAGE_CH, platformId: "aBcPerson12", metadata: null }] });
    await runCommentSweep(personal.deps as any, CFG);
    expect(personal.readLinkedInComments).not.toHaveBeenCalled();
    expect(personal.reserveLinkedInCalls).not.toHaveBeenCalled();
  });
});
