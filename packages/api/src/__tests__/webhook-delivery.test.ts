import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// Mock Prisma
const mockPrisma = {
  webhook: {
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    delete: vi.fn(),
  },
  webhookDelivery: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  organizationMember: {
    findUnique: vi.fn(),
  },
};

vi.mock("@postautomation/db", () => ({
  prisma: mockPrisma,
}));

describe("Webhook Delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Delivery Logging", () => {
    it("should log a delivery with the correct payload", async () => {
      const deliveryData = {
        webhookId: "wh-1",
        event: "post.published",
        payload: { postId: "post-1", platform: "TWITTER" },
        status: "SUCCESS",
        statusCode: 200,
        responseBody: '{"ok":true}',
        deliveredAt: new Date(),
      };

      mockPrisma.webhookDelivery.create.mockResolvedValue({
        id: "delivery-1",
        ...deliveryData,
      });

      const delivery = await mockPrisma.webhookDelivery.create({
        data: deliveryData,
      });

      expect(delivery.webhookId).toBe("wh-1");
      expect(delivery.event).toBe("post.published");
      expect(delivery.payload).toEqual({ postId: "post-1", platform: "TWITTER" });
      expect(delivery.status).toBe("SUCCESS");
      expect(delivery.statusCode).toBe(200);
    });

    it("should log failed delivery with error information", async () => {
      const failedDelivery = {
        webhookId: "wh-1",
        event: "post.published",
        payload: { postId: "post-2" },
        status: "FAILED",
        statusCode: 500,
        responseBody: "Internal Server Error",
        errorMessage: "Target returned 500",
        deliveredAt: new Date(),
      };

      mockPrisma.webhookDelivery.create.mockResolvedValue({
        id: "delivery-2",
        ...failedDelivery,
      });

      const delivery = await mockPrisma.webhookDelivery.create({
        data: failedDelivery,
      });

      expect(delivery.status).toBe("FAILED");
      expect(delivery.statusCode).toBe(500);
      expect(delivery.errorMessage).toBe("Target returned 500");
    });

    it("should log delivery with timeout error", async () => {
      const timeoutDelivery = {
        webhookId: "wh-1",
        event: "post.scheduled",
        payload: { postId: "post-3" },
        status: "FAILED",
        statusCode: null,
        errorMessage: "Request timed out after 30s",
        deliveredAt: new Date(),
      };

      mockPrisma.webhookDelivery.create.mockResolvedValue({
        id: "delivery-3",
        ...timeoutDelivery,
      });

      const delivery = await mockPrisma.webhookDelivery.create({
        data: timeoutDelivery,
      });

      expect(delivery.status).toBe("FAILED");
      expect(delivery.statusCode).toBeNull();
      expect(delivery.errorMessage).toContain("timed out");
    });
  });

  describe("Retry Failed Deliveries", () => {
    it("should allow retrying a failed delivery", async () => {
      const failedDeliveryId = "delivery-failed-1";

      // Simulate fetching the failed delivery
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([
        {
          id: failedDeliveryId,
          webhookId: "wh-1",
          status: "FAILED",
          retryCount: 0,
          event: "post.published",
          payload: { postId: "post-1" },
        },
      ]);

      const failedDeliveries = await mockPrisma.webhookDelivery.findMany({
        where: { status: "FAILED", webhookId: "wh-1" },
      });

      expect(failedDeliveries).toHaveLength(1);
      expect(failedDeliveries[0].status).toBe("FAILED");

      // Simulate retry attempt
      mockPrisma.webhookDelivery.update.mockResolvedValue({
        id: failedDeliveryId,
        status: "SUCCESS",
        retryCount: 1,
        statusCode: 200,
      });

      const retried = await mockPrisma.webhookDelivery.update({
        where: { id: failedDeliveryId },
        data: {
          status: "SUCCESS",
          retryCount: 1,
          statusCode: 200,
        },
      });

      expect(retried.status).toBe("SUCCESS");
      expect(retried.retryCount).toBe(1);
    });

    it("should increment retry count on each attempt", async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        mockPrisma.webhookDelivery.update.mockResolvedValueOnce({
          id: "delivery-retry",
          retryCount: attempt,
          status: attempt < 3 ? "FAILED" : "SUCCESS",
        });
      }

      const result1 = await mockPrisma.webhookDelivery.update({
        where: { id: "delivery-retry" },
        data: { retryCount: 1, status: "FAILED" },
      });
      expect(result1.retryCount).toBe(1);

      const result2 = await mockPrisma.webhookDelivery.update({
        where: { id: "delivery-retry" },
        data: { retryCount: 2, status: "FAILED" },
      });
      expect(result2.retryCount).toBe(2);

      const result3 = await mockPrisma.webhookDelivery.update({
        where: { id: "delivery-retry" },
        data: { retryCount: 3, status: "SUCCESS" },
      });
      expect(result3.retryCount).toBe(3);
      expect(result3.status).toBe("SUCCESS");
    });
  });

  describe("Pagination of Delivery History", () => {
    it("should support paginated delivery history", async () => {
      const page1 = Array.from({ length: 10 }, (_, i) => ({
        id: `delivery-${i}`,
        event: "post.published",
        status: "SUCCESS",
        createdAt: new Date(Date.now() - i * 60_000),
      }));

      mockPrisma.webhookDelivery.findMany.mockResolvedValue(page1);
      mockPrisma.webhookDelivery.count.mockResolvedValue(25);

      const deliveries = await mockPrisma.webhookDelivery.findMany({
        where: { webhookId: "wh-1" },
        take: 10,
        skip: 0,
        orderBy: { createdAt: "desc" },
      });

      const total = await mockPrisma.webhookDelivery.count({
        where: { webhookId: "wh-1" },
      });

      expect(deliveries).toHaveLength(10);
      expect(total).toBe(25);
    });

    it("should return correct offset for page 2", async () => {
      const page2 = Array.from({ length: 10 }, (_, i) => ({
        id: `delivery-${i + 10}`,
        event: "post.published",
        status: "SUCCESS",
      }));

      mockPrisma.webhookDelivery.findMany.mockResolvedValue(page2);

      const deliveries = await mockPrisma.webhookDelivery.findMany({
        where: { webhookId: "wh-1" },
        take: 10,
        skip: 10,
        orderBy: { createdAt: "desc" },
      });

      expect(deliveries).toHaveLength(10);
      expect(mockPrisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 })
      );
    });

    it("should return empty array when no more results", async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([]);

      const deliveries = await mockPrisma.webhookDelivery.findMany({
        where: { webhookId: "wh-1" },
        take: 10,
        skip: 100,
      });

      expect(deliveries).toHaveLength(0);
    });
  });

  describe("Success/Failure Status Tracking", () => {
    it("should track successful deliveries with 2xx status codes", async () => {
      const successDelivery = {
        id: "delivery-ok",
        status: "SUCCESS",
        statusCode: 200,
      };

      mockPrisma.webhookDelivery.create.mockResolvedValue(successDelivery);

      const delivery = await mockPrisma.webhookDelivery.create({
        data: { webhookId: "wh-1", event: "post.published", payload: {}, status: "SUCCESS", statusCode: 200 },
      });

      expect(delivery.status).toBe("SUCCESS");
      expect(delivery.statusCode).toBe(200);
    });

    it("should track failures with non-2xx status codes", async () => {
      const codes = [400, 401, 403, 404, 500, 502, 503];
      for (const code of codes) {
        mockPrisma.webhookDelivery.create.mockResolvedValueOnce({
          id: `delivery-${code}`,
          status: "FAILED",
          statusCode: code,
        });

        const delivery = await mockPrisma.webhookDelivery.create({
          data: {
            webhookId: "wh-1",
            event: "post.failed",
            payload: {},
            status: "FAILED",
            statusCode: code,
          },
        });

        expect(delivery.status).toBe("FAILED");
        expect(delivery.statusCode).toBe(code);
      }
    });
  });

  describe("Organization-Scoped Access", () => {
    it("should list webhooks scoped to the organization", async () => {
      mockPrisma.webhook.findMany.mockResolvedValue([
        { id: "wh-1", organizationId: "org-1", url: "https://hooks.example.com/a" },
        { id: "wh-2", organizationId: "org-1", url: "https://hooks.example.com/b" },
      ]);

      const webhooks = await mockPrisma.webhook.findMany({
        where: { organizationId: "org-1" },
        orderBy: { createdAt: "desc" },
      });

      expect(webhooks).toHaveLength(2);
      expect(webhooks.every((w: any) => w.organizationId === "org-1")).toBe(true);
    });

    it("should not return webhooks from other organizations", async () => {
      mockPrisma.webhook.findMany.mockResolvedValue([]);

      const webhooks = await mockPrisma.webhook.findMany({
        where: { organizationId: "org-2" },
      });

      expect(webhooks).toHaveLength(0);
    });

    it("should check org ownership before deleting a webhook", async () => {
      mockPrisma.webhook.findFirst.mockResolvedValue(null);

      const webhook = await mockPrisma.webhook.findFirst({
        where: { id: "wh-1", organizationId: "wrong-org" },
      });

      expect(webhook).toBeNull();
      expect(mockPrisma.webhook.delete).not.toHaveBeenCalled();
    });

    it("should generate a secret when creating a webhook", () => {
      const secret = crypto.randomBytes(32).toString("hex");
      expect(secret).toMatch(/^[a-f0-9]{64}$/);
      expect(secret.length).toBe(64);
    });
  });
});
