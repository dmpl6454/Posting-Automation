/**
 * webhook.create checks every address the endpoint's name RESOLVES to
 * (2026-10-01). Its URL schema is a hostname regex: it misses any domain
 * pointed at a private address, every IPv6 form and CGNAT. Delivery itself goes
 * through userHostFetch (apps/worker webhook-delivery-ssrf.test.ts); this makes
 * the mistake visible when the webhook is saved, not on the first event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const lookupMock = vi.fn(async (..._a: any[]): Promise<Array<{ address: string; family: number }>> => []);
vi.mock("node:dns", () => {
  const promises = { lookup: (...a: any[]) => lookupMock(...a) };
  return { promises, default: { promises } };
});

vi.mock("../middleware/plan-limit.middleware", () => ({
  requirePlan: vi.fn(async () => undefined),
  checkUsageLimit: vi.fn(async () => ({ allowed: true, current: 0, limit: -1, planName: "Pro" })),
  enforcePlanLimit: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));
vi.mock("../lib/audit", () => ({ createAuditLog: vi.fn(async () => {}), AUDIT_ACTIONS: { WEBHOOK_CREATED: "x" } }));

const webhookCreate = vi.fn(async (...a: any[]) => ({ id: "w1", ...a[0].data }));
vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })),
    },
    organization: { findUnique: vi.fn(async () => ({ plan: "PROFESSIONAL", planExpiresAt: null })) },
    webhook: { create: (...a: any[]) => webhookCreate(...a) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { webhookRouter } from "../routers/webhook.router";
import { prisma as prismaMock } from "@postautomation/db";

const caller = () =>
  createCallerFactory(webhookRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: { user: { id: "u1", email: "a@b.c", isSuperAdmin: false, appRole: "ADMIN" }, expires: "2099-01-01" } as any,
  });

beforeEach(() => {
  vi.clearAllMocks();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("webhook.create — resolved-address check", () => {
  it("refuses a public-looking name that resolves to a private address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "172.18.0.4", family: 4 }]);
    await expect(caller().create({ url: "https://hooks.example.com/in", events: ["post.published"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(webhookCreate).not.toHaveBeenCalled();
  });

  it.each(["https://[fd00::1]/in", "https://[::ffff:a9fe:a9fe]/in", "https://100.100.100.200/in"])(
    "refuses %s, which the hostname regex let through",
    async (url) => {
      await expect(caller().create({ url, events: ["post.published"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(webhookCreate).not.toHaveBeenCalled();
    },
  );

  it("refuses a name that does not resolve", async () => {
    lookupMock.mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(caller().create({ url: "https://nope.example.com/in", events: ["post.published"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(webhookCreate).not.toHaveBeenCalled();
  });

  it("saves a public endpoint", async () => {
    await expect(caller().create({ url: "https://hooks.example.com/in", events: ["post.published"] })).resolves.toMatchObject({
      id: "w1",
    });
    expect(webhookCreate).toHaveBeenCalledTimes(1);
  });
});
