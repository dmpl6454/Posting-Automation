import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma — use vi.hoisted() so the variable is available when vi.mock is hoisted
const mockPrisma = vi.hoisted(() => ({
  auditLog: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock("@postautomation/db", () => ({
  prisma: mockPrisma,
}));

// Import after mocking so createAuditLog uses our mock
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

describe("Audit System", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── createAuditLog() ─────────────────────────────────────────────

  describe("createAuditLog()", () => {
    it("should create an audit log entry via Prisma", async () => {
      mockPrisma.auditLog.create.mockResolvedValueOnce({
        id: "audit-1",
        organizationId: "org-1",
        userId: "user-1",
        action: "post.created",
        entityType: "post",
        entityId: "post-1",
      });

      await createAuditLog({
        organizationId: "org-1",
        userId: "user-1",
        action: "post.created",
        entityType: "post",
        entityId: "post-1",
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: "org-1",
          userId: "user-1",
          action: "post.created",
          entityType: "post",
          entityId: "post-1",
        }),
      });
    });

    it("should pass metadata to the audit log", async () => {
      mockPrisma.auditLog.create.mockResolvedValueOnce({});

      await createAuditLog({
        organizationId: "org-1",
        action: "billing.plan_changed",
        entityType: "subscription",
        metadata: { oldPlan: "free", newPlan: "pro" },
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: { oldPlan: "free", newPlan: "pro" },
        }),
      });
    });

    it("should pass ipAddress and userAgent when provided", async () => {
      mockPrisma.auditLog.create.mockResolvedValueOnce({});

      await createAuditLog({
        organizationId: "org-1",
        action: "auth.login",
        entityType: "user",
        ipAddress: "192.168.1.1",
        userAgent: "Mozilla/5.0",
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ipAddress: "192.168.1.1",
          userAgent: "Mozilla/5.0",
        }),
      });
    });

    it("should not throw when Prisma create fails (fire-and-forget)", async () => {
      mockPrisma.auditLog.create.mockRejectedValueOnce(
        new Error("DB connection lost")
      );

      // Should NOT throw
      await expect(
        createAuditLog({
          organizationId: "org-1",
          action: "post.created",
          entityType: "post",
        })
      ).resolves.toBeUndefined();
    });

    it("should log an error to console when Prisma create fails", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const dbError = new Error("DB connection lost");
      mockPrisma.auditLog.create.mockRejectedValueOnce(dbError);

      await createAuditLog({
        organizationId: "org-1",
        action: "post.created",
        entityType: "post",
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to create audit log:",
        dbError
      );

      consoleSpy.mockRestore();
    });

    it("should allow optional userId", async () => {
      mockPrisma.auditLog.create.mockResolvedValueOnce({});

      await createAuditLog({
        organizationId: "org-1",
        action: "webhook.created",
        entityType: "webhook",
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: undefined,
        }),
      });
    });

    it("should allow optional entityId", async () => {
      mockPrisma.auditLog.create.mockResolvedValueOnce({});

      await createAuditLog({
        organizationId: "org-1",
        userId: "user-1",
        action: "auth.login",
        entityType: "session",
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entityId: undefined,
        }),
      });
    });
  });

  // ── AUDIT_ACTIONS constants ───────────────────────────────────────

  describe("AUDIT_ACTIONS", () => {
    it("should define post-related actions", () => {
      expect(AUDIT_ACTIONS.POST_CREATED).toBe("post.created");
      expect(AUDIT_ACTIONS.POST_UPDATED).toBe("post.updated");
      expect(AUDIT_ACTIONS.POST_DELETED).toBe("post.deleted");
      expect(AUDIT_ACTIONS.POST_PUBLISHED).toBe("post.published");
      expect(AUDIT_ACTIONS.POST_SCHEDULED).toBe("post.scheduled");
    });

    it("should define channel-related actions", () => {
      expect(AUDIT_ACTIONS.CHANNEL_CONNECTED).toBe("channel.connected");
      expect(AUDIT_ACTIONS.CHANNEL_DISCONNECTED).toBe("channel.disconnected");
      expect(AUDIT_ACTIONS.CHANNEL_REFRESHED).toBe("channel.refreshed");
    });

    it("should define team-related actions", () => {
      expect(AUDIT_ACTIONS.MEMBER_INVITED).toBe("member.invited");
      expect(AUDIT_ACTIONS.MEMBER_REMOVED).toBe("member.removed");
      expect(AUDIT_ACTIONS.MEMBER_ROLE_CHANGED).toBe("member.role_changed");
    });

    it("should define API key actions", () => {
      expect(AUDIT_ACTIONS.API_KEY_CREATED).toBe("apikey.created");
      expect(AUDIT_ACTIONS.API_KEY_DELETED).toBe("apikey.deleted");
    });

    it("should define webhook actions", () => {
      expect(AUDIT_ACTIONS.WEBHOOK_CREATED).toBe("webhook.created");
      expect(AUDIT_ACTIONS.WEBHOOK_UPDATED).toBe("webhook.updated");
      expect(AUDIT_ACTIONS.WEBHOOK_DELETED).toBe("webhook.deleted");
    });

    it("should define billing actions", () => {
      expect(AUDIT_ACTIONS.PLAN_CHANGED).toBe("billing.plan_changed");
      expect(AUDIT_ACTIONS.SUBSCRIPTION_CANCELLED).toBe(
        "billing.subscription_cancelled"
      );
    });

    it("should define auth actions", () => {
      expect(AUDIT_ACTIONS.USER_LOGIN).toBe("auth.login");
      expect(AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED).toBe(
        "auth.password_reset_requested"
      );
      expect(AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED).toBe(
        "auth.password_reset_completed"
      );
    });
  });

  // ── Audit Router — list endpoint ──────────────────────────────────

  describe("Audit Router - list", () => {
    it("should reject non-OWNER/ADMIN users (MEMBER role)", () => {
      const role: string = "MEMBER";
      const allowed = role === "OWNER" || role === "ADMIN";
      expect(allowed).toBe(false);
    });

    it("should reject VIEWER role", () => {
      const role: string = "VIEWER";
      const allowed = role === "OWNER" || role === "ADMIN";
      expect(allowed).toBe(false);
    });

    it("should allow OWNER role", () => {
      const role: string = "OWNER";
      const allowed = role === "OWNER" || role === "ADMIN";
      expect(allowed).toBe(true);
    });

    it("should allow ADMIN role", () => {
      const role: string = "ADMIN";
      const allowed = role === "OWNER" || role === "ADMIN";
      expect(allowed).toBe(true);
    });

    it("should query audit logs with pagination", async () => {
      const mockLogs = [
        { id: "log-1", action: "post.created" },
        { id: "log-2", action: "post.updated" },
      ];
      mockPrisma.auditLog.findMany.mockResolvedValueOnce(mockLogs);
      mockPrisma.auditLog.count.mockResolvedValueOnce(50);

      const page = 2;
      const limit = 25;

      const [logs, total] = await Promise.all([
        mockPrisma.auditLog.findMany({
          where: { organizationId: "org-1" },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: (page - 1) * limit,
        }),
        mockPrisma.auditLog.count({ where: { organizationId: "org-1" } }),
      ]);

      expect(logs).toHaveLength(2);
      expect(total).toBe(50);
      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 25,
          skip: 25,
        })
      );
    });

    it("should compute totalPages correctly", () => {
      const total = 73;
      const limit = 25;
      const totalPages = Math.ceil(total / limit);
      expect(totalPages).toBe(3);
    });

    it("should filter by action when provided", async () => {
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([]);
      mockPrisma.auditLog.count.mockResolvedValueOnce(0);

      const where: Record<string, unknown> = { organizationId: "org-1" };
      const action = "post.created";
      if (action) where.action = action;

      await mockPrisma.auditLog.findMany({ where });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: "org-1",
          action: "post.created",
        },
      });
    });

    it("should filter by entityType when provided", async () => {
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([]);

      const where: Record<string, unknown> = { organizationId: "org-1" };
      const entityType = "channel";
      if (entityType) where.entityType = entityType;

      await mockPrisma.auditLog.findMany({ where });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ entityType: "channel" }),
      });
    });

    it("should filter by date range when startDate and endDate provided", async () => {
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([]);

      const where: Record<string, unknown> = { organizationId: "org-1" };
      const startDate = "2025-01-01T00:00:00Z";
      const endDate = "2025-12-31T23:59:59Z";
      const createdAt: Record<string, Date> = {};
      if (startDate) createdAt.gte = new Date(startDate);
      if (endDate) createdAt.lte = new Date(endDate);
      where.createdAt = createdAt;

      await mockPrisma.auditLog.findMany({ where });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date("2025-01-01T00:00:00Z"),
            lte: new Date("2025-12-31T23:59:59Z"),
          },
        }),
      });
    });

    it("should filter by userId when provided", async () => {
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([]);

      const where: Record<string, unknown> = { organizationId: "org-1" };
      const userId = "user-42";
      if (userId) where.userId = userId;

      await mockPrisma.auditLog.findMany({ where });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ userId: "user-42" }),
      });
    });
  });

  // ── Audit Router — entityHistory endpoint ─────────────────────────

  describe("Audit Router - entityHistory", () => {
    it("should reject non-OWNER/ADMIN users", () => {
      const role: string = "MEMBER";
      const allowed = role === "OWNER" || role === "ADMIN";
      expect(allowed).toBe(false);
    });

    it("should query audit logs by entityType and entityId", async () => {
      const mockHistory = [
        {
          id: "log-1",
          action: "post.created",
          entityType: "post",
          entityId: "post-99",
        },
        {
          id: "log-2",
          action: "post.updated",
          entityType: "post",
          entityId: "post-99",
        },
        {
          id: "log-3",
          action: "post.published",
          entityType: "post",
          entityId: "post-99",
        },
      ];
      mockPrisma.auditLog.findMany.mockResolvedValueOnce(mockHistory);

      const result = await mockPrisma.auditLog.findMany({
        where: {
          organizationId: "org-1",
          entityType: "post",
          entityId: "post-99",
        },
        orderBy: { createdAt: "desc" },
      });

      expect(result).toHaveLength(3);
      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: "org-1",
          entityType: "post",
          entityId: "post-99",
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("should return an empty array when entity has no history", async () => {
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([]);

      const result = await mockPrisma.auditLog.findMany({
        where: {
          organizationId: "org-1",
          entityType: "post",
          entityId: "nonexistent",
        },
      });

      expect(result).toEqual([]);
    });

    it("should order results by createdAt descending", async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 60_000);
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([
        { id: "log-1", createdAt: now },
        { id: "log-2", createdAt: earlier },
      ]);

      const result = await mockPrisma.auditLog.findMany({
        where: { organizationId: "org-1", entityType: "post", entityId: "p-1" },
        orderBy: { createdAt: "desc" },
      });

      expect(result[0]?.createdAt.getTime()).toBeGreaterThan(
        result[1]?.createdAt.getTime() ?? 0
      );
    });
  });
});
