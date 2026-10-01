/**
 * notification.create had NO org-membership check on its target userId and no
 * validation on `link`: any app-ADMIN could plant a notification in a
 * stranger's feed, in any workspace, with an attacker-chosen link the client
 * would navigate to on click (security audit 2026-09-28). Nothing in the UI
 * ever called it — every real producer writes through Prisma directly.
 */
import { describe, it, expect } from "vitest";
import { notificationRouter } from "../routers/notification.router";

describe("notification.create", () => {
  it("no longer exists", () => {
    expect((notificationRouter as any)._def.procedures.create).toBeUndefined();
  });

  it("the harmless user-scoped procedures are untouched", () => {
    for (const name of ["list", "unreadCount", "markRead", "markAllRead"]) {
      expect((notificationRouter as any)._def.procedures[name]).toBeDefined();
    }
  });
});
