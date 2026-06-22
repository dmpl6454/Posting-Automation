/**
 * monitor.clearResolved (2026-06-22) — a super-admin "Clear resolved" action that
 * hard-deletes every resolved ErrorLog row on demand (the manual companion to the
 * daily auto-purge cron). Exercises the REAL router through a tRPC caller.
 *
 *   - deletes ONLY resolved rows (never touches open errors)
 *   - super-admin only (cross-tenant table), like every other monitor read/write
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createCallerFactory } from "../trpc";
import { monitorRouter } from "../routers/monitor.router";

const USER_ID = "admin-1";

function buildCaller(opts: { isSuperAdmin: boolean }) {
  const deleteMany = vi.fn(async (_args: { where: any }) => ({ count: 5 }));
  const prisma = { errorLog: { deleteMany } } as any;
  const caller = createCallerFactory(monitorRouter)({
    prisma,
    session: { user: { id: USER_ID, email: "a@example.com", isSuperAdmin: opts.isSuperAdmin } },
  } as any);
  return { caller, deleteMany };
}

describe("monitor.clearResolved", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes only resolved rows and returns the count", async () => {
    const { caller, deleteMany } = buildCaller({ isSuperAdmin: true });
    const res = await caller.clearResolved();
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0]![0]!).toEqual({ where: { resolved: true } });
    expect(res).toEqual({ count: 5 });
  });

  it("is FORBIDDEN for non-super-admins", async () => {
    const { caller, deleteMany } = buildCaller({ isSuperAdmin: false });
    await expect(caller.clearResolved()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
