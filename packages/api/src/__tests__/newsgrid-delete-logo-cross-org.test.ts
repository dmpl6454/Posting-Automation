/**
 * newsgrid.deleteLogo must never delete a Media row belonging to ANOTHER
 * organization (security audit 2026-09-28, confirmed).
 *
 * The lookup that gates it (`media.findFirst({ where: { id, organizationId } })`)
 * is correctly org-scoped and returns null for a foreign id — but the final
 * `media.delete({ where: { id: input.mediaId } })` ran UNCONDITIONALLY, by the
 * bare client-supplied id, with no organizationId filter and no check that the
 * earlier lookup actually found anything. So a foreign id — one belonging to a
 * DIFFERENT org's uploaded logo, wallpaper, or any other Media row — was
 * deleted anyway, cross-tenant, by any app-ADMIN (or every user under
 * RBAC_DISABLED=true).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mediaFindFirst = vi.fn();
const mediaDelete = vi.fn(async (_a: any) => ({}));
const channelFindFirst = vi.fn();
const channelFindMany = vi.fn(async (_a: any) => [] as any[]);
const channelUpdate = vi.fn(async (_a: any) => ({}));

vi.mock("@postautomation/queue", () => ({ postPublishQueue: { add: vi.fn() } }));

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })) },
    organization: { findUnique: vi.fn(async () => null) },
    media: { findFirst: (a: any) => mediaFindFirst(a), delete: (a: any) => mediaDelete(a) },
    channel: {
      findFirst: (a: any) => channelFindFirst(a),
      findMany: (a: any) => channelFindMany(a),
      update: (a: any) => channelUpdate(a),
    },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { newsgridRouter } from "../routers/newsgrid.router";

function caller() {
  return createCallerFactory(newsgridRouter)({
    prisma: {
      organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })) },
      organization: { findUnique: vi.fn(async () => null) },
      media: { findFirst: (a: any) => mediaFindFirst(a), delete: (a: any) => mediaDelete(a) },
      channel: { findFirst: (a: any) => channelFindFirst(a), findMany: (a: any) => channelFindMany(a), update: (a: any) => channelUpdate(a) },
    } as any,
    organizationId: "org-1",
    session: { user: { id: "u1", email: "u@x.com", isSuperAdmin: false, appRole: "ADMIN" }, expires: "2099-01-01" } as any,
  } as any);
}

beforeEach(() => vi.clearAllMocks());

describe("newsgrid.deleteLogo", () => {
  it("refuses (and never calls delete) when the media does not belong to this org", async () => {
    mediaFindFirst.mockResolvedValue(null); // the org-scoped lookup found nothing
    await expect(caller().deleteLogo({ mediaId: "foreign-media-id" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(mediaDelete).not.toHaveBeenCalled();
  });

  it("still deletes a media row that genuinely belongs to this org", async () => {
    mediaFindFirst.mockResolvedValue({ url: "https://x/logo.png", channelId: null });
    await expect(caller().deleteLogo({ mediaId: "owned-media-id" })).resolves.toEqual({ success: true });
    expect(mediaDelete).toHaveBeenCalledWith({ where: { id: "owned-media-id" } });
  });
});
