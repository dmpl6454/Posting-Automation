/**
 * monitor.resolveAll (2026-06-22) — a super-admin "Resolve All" action that marks
 * EVERY unresolved ErrorLog row matching the current source/severity filter as
 * resolved, in a single server-side updateMany.
 *
 * Root cause this replaces: the Monitoring page's "Resolve All" button mapped the
 * ≤50 IDs of the *loaded list page* and called bulkResolve, so clicking it on a
 * 6294-row backlog only ever resolved the 50 visible rows (6294 → 6244). The count
 * (monitor.stats) is a server-side COUNT over the whole filter scope, so the button
 * must operate on that SAME scope — not on the paginated list's IDs.
 *
 *   - resolves ALL matching rows regardless of pagination (filter-scoped updateMany)
 *   - always pins `resolved: false` so already-resolved rows are untouched
 *   - applies the source/severity filter exactly like the list/stats scope
 *   - super-admin only (cross-tenant table), like every other monitor write
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createCallerFactory } from "../trpc";
import { monitorRouter } from "../routers/monitor.router";

const USER_ID = "admin-1";

function buildCaller(opts: { isSuperAdmin: boolean }) {
  const updateMany = vi.fn(async (_args: { where: any; data: any }) => ({ count: 6294 }));
  const prisma = { errorLog: { updateMany } } as any;
  const caller = createCallerFactory(monitorRouter)({
    prisma,
    session: { user: { id: USER_ID, email: "a@example.com", isSuperAdmin: opts.isSuperAdmin } },
  } as any);
  return { caller, updateMany };
}

describe("monitor.resolveAll", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves ALL unresolved rows when no filter is applied (source=all, severity=all)", async () => {
    const { caller, updateMany } = buildCaller({ isSuperAdmin: true });
    const res = await caller.resolveAll({ source: "all", severity: "all" });

    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0]![0]!;
    // Scope = every unresolved row (no source/severity narrowing) — matches the
    // monitor.stats `count({ where: { resolved: false } })` the UI displays.
    expect(arg.where).toEqual({ resolved: false });
    expect(arg.data).toMatchObject({ resolved: true });
    expect(arg.data.resolvedBy).toBe(USER_ID);
    expect(arg.data.resolvedAt).toBeInstanceOf(Date);
    // Returns the real DB count, not a hardcoded page size.
    expect(res).toEqual({ count: 6294 });
  });

  it("narrows to the active source/severity filter when one is set", async () => {
    const { caller, updateMany } = buildCaller({ isSuperAdmin: true });
    await caller.resolveAll({ source: "publish", severity: "critical" });

    const arg = updateMany.mock.calls[0]![0]!;
    expect(arg.where).toEqual({ resolved: false, source: "publish", severity: "critical" });
  });

  it("defaults to source=all / severity=all when omitted", async () => {
    const { caller, updateMany } = buildCaller({ isSuperAdmin: true });
    await caller.resolveAll({});

    const arg = updateMany.mock.calls[0]![0]!;
    expect(arg.where).toEqual({ resolved: false });
  });

  it("is FORBIDDEN for non-super-admins", async () => {
    const { caller, updateMany } = buildCaller({ isSuperAdmin: false });
    await expect(caller.resolveAll({ source: "all", severity: "all" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
