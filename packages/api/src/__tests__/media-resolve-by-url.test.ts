/**
 * Regression guard for media.resolveByUrl — the resolver ComposeTab uses to turn a
 * url-only `postMedia` item (e.g. a Repurpose "Create Post" deep link `?aiImage=<url>`
 * that arrived WITHOUT `aiMediaId`) back into its existing org Media id, so the image
 * is NOT silently dropped at post-create time (the 2026-06-26 bug).
 *
 * Invariants asserted:
 *  1. The Prisma query is ALWAYS org-scoped (organizationId == ctx.organizationId)
 *     AND url ∈ requested urls — so it cannot leak another org's media (IDOR).
 *  2. The returned `map` is url → mediaId for the rows found; unresolved urls are
 *     simply ABSENT from the map (the caller decides to fall back or block).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCallerFactory } from "../trpc";
import { mediaRouter } from "../routers/media.router";

const ORG = "org_self";
const createCaller = createCallerFactory(mediaRouter);

let lastWhere: any = null;
const media = {
  findMany: vi.fn(async ({ where, select: _s }: any) => {
    lastWhere = where;
    // Pretend the DB holds two org-owned rows; return only those whose url was asked for.
    const owned: Record<string, string> = {
      "https://cdn/x/a.png": "media_a",
      "https://cdn/x/b.png": "media_b",
    };
    return (where.url.in as string[])
      .filter((u) => owned[u])
      .map((u) => ({ id: owned[u], url: u }));
  }),
};

function caller(orgId = ORG) {
  return createCaller({
    prisma: {
      media,
      // orgProcedure membership gate — a real membership is required for every actor.
      organizationMember: {
        findUnique: vi.fn(async () => ({ userId: "u1", organizationId: orgId, role: "OWNER" })),
      },
    } as any,
    // superAdmin to skip the planExpiresAt org.findUnique block — orgProcedure still
    // requires a real membership (mocked above), so the org-scoping assertion is intact.
    session: { user: { id: "u1", email: "u@e.com", isSuperAdmin: true } } as any,
    organizationId: orgId,
  } as any);
}

beforeEach(() => {
  media.findMany.mockClear();
  lastWhere = null;
});

describe("media.resolveByUrl", () => {
  it("maps known org-owned urls to their media ids and OMITS unknown urls", async () => {
    const res = await caller().resolveByUrl({
      urls: ["https://cdn/x/a.png", "https://cdn/x/missing.png", "https://cdn/x/b.png"],
    });
    expect(res.map).toEqual({ "https://cdn/x/a.png": "media_a", "https://cdn/x/b.png": "media_b" });
    // missing url is absent (not null/empty) — caller falls back or blocks.
    expect("https://cdn/x/missing.png" in res.map).toBe(false);
  });

  it("ALWAYS scopes the query to the acting org + requested urls (IDOR guard)", async () => {
    await caller("org_self").resolveByUrl({ urls: ["https://cdn/x/a.png"] });
    expect(lastWhere.organizationId).toBe("org_self");
    expect(lastWhere.url.in).toEqual(["https://cdn/x/a.png"]);
  });

  it("rejects empty and oversized url lists", async () => {
    await expect(caller().resolveByUrl({ urls: [] })).rejects.toBeTruthy();
    await expect(
      caller().resolveByUrl({ urls: Array.from({ length: 21 }, (_, i) => `https://cdn/x/${i}.png`) }),
    ).rejects.toBeTruthy();
  });
});
