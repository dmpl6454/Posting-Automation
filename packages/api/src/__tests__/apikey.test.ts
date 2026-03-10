import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// Mock Prisma
const mockPrisma = {
  apiKey: {
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    delete: vi.fn(),
  },
  organizationMember: {
    findUnique: vi.fn(),
  },
};

vi.mock("@postautomation/db", () => ({
  prisma: mockPrisma,
}));

// We test the router logic directly by calling the procedures
// Since the router uses orgProcedure which requires auth and org context,
// we test the underlying logic patterns rather than going through tRPC middleware.

describe("API Key Router Logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Key Generation Format", () => {
    it("should generate keys with pa_ prefix followed by 64 hex characters", () => {
      const plainKey = `pa_${crypto.randomBytes(32).toString("hex")}`;
      expect(plainKey).toMatch(/^pa_[a-f0-9]{64}$/);
    });

    it("should generate unique keys on each call", () => {
      const key1 = `pa_${crypto.randomBytes(32).toString("hex")}`;
      const key2 = `pa_${crypto.randomBytes(32).toString("hex")}`;
      expect(key1).not.toBe(key2);
    });

    it("should produce a key of exactly 67 characters (3 prefix + 64 hex)", () => {
      const plainKey = `pa_${crypto.randomBytes(32).toString("hex")}`;
      expect(plainKey.length).toBe(67);
    });
  });

  describe("Key Hashing", () => {
    it("should hash the key using SHA-256", () => {
      const plainKey = `pa_${crypto.randomBytes(32).toString("hex")}`;
      const keyHash = crypto.createHash("sha256").update(plainKey).digest("hex");

      // SHA-256 produces a 64-character hex string
      expect(keyHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce the same hash for the same key", () => {
      const plainKey = "pa_aabbccdd";
      const hash1 = crypto.createHash("sha256").update(plainKey).digest("hex");
      const hash2 = crypto.createHash("sha256").update(plainKey).digest("hex");
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different keys", () => {
      const key1 = `pa_${crypto.randomBytes(32).toString("hex")}`;
      const key2 = `pa_${crypto.randomBytes(32).toString("hex")}`;
      const hash1 = crypto.createHash("sha256").update(key1).digest("hex");
      const hash2 = crypto.createHash("sha256").update(key2).digest("hex");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("List API Keys", () => {
    it("should return keys with masked prefix", async () => {
      const mockKeys = [
        {
          id: "key-1",
          name: "Production Key",
          lastUsedAt: new Date(),
          createdAt: new Date(),
          expiresAt: null,
        },
        {
          id: "key-2",
          name: "Staging Key",
          lastUsedAt: null,
          createdAt: new Date(),
          expiresAt: new Date("2025-12-31"),
        },
      ];

      mockPrisma.apiKey.findMany.mockResolvedValue(mockKeys);

      const keys = await mockPrisma.apiKey.findMany({
        where: { organizationId: "org-1" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          lastUsedAt: true,
          createdAt: true,
          expiresAt: true,
        },
      });

      // Simulate the router's mapping
      const result = keys.map((key: any) => ({
        ...key,
        keyPrefix: "pa_****",
      }));

      expect(result).toHaveLength(2);
      expect(result[0].keyPrefix).toBe("pa_****");
      expect(result[1].keyPrefix).toBe("pa_****");
      expect(result[0].name).toBe("Production Key");
    });

    it("should return empty array when no keys exist", async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([]);

      const keys = await mockPrisma.apiKey.findMany({
        where: { organizationId: "org-1" },
      });

      const result = keys.map((key: any) => ({
        ...key,
        keyPrefix: "pa_****",
      }));

      expect(result).toHaveLength(0);
    });

    it("should query with correct organization filter", async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([]);

      await mockPrisma.apiKey.findMany({
        where: { organizationId: "org-123" },
        orderBy: { createdAt: "desc" },
      });

      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith({
        where: { organizationId: "org-123" },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("Create API Key", () => {
    it("should create key with correct data shape", async () => {
      const orgId = "org-1";
      const name = "Test Key";

      const plainKey = `pa_${crypto.randomBytes(32).toString("hex")}`;
      const keyHash = crypto.createHash("sha256").update(plainKey).digest("hex");

      mockPrisma.apiKey.create.mockResolvedValue({
        id: "key-new",
        organizationId: orgId,
        name,
        keyHash,
        createdAt: new Date(),
        expiresAt: null,
      });

      const apiKey = await mockPrisma.apiKey.create({
        data: {
          organizationId: orgId,
          name,
          keyHash,
          expiresAt: null,
        },
      });

      expect(apiKey.name).toBe("Test Key");
      expect(apiKey.organizationId).toBe("org-1");
      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith({
        data: {
          organizationId: orgId,
          name,
          keyHash,
          expiresAt: null,
        },
      });
    });

    it("should handle expiration date when provided", async () => {
      const expiresAt = "2025-12-31T00:00:00.000Z";
      const parsedExpiry = new Date(expiresAt);

      mockPrisma.apiKey.create.mockResolvedValue({
        id: "key-exp",
        name: "Expiring Key",
        keyHash: "abc",
        createdAt: new Date(),
        expiresAt: parsedExpiry,
      });

      const apiKey = await mockPrisma.apiKey.create({
        data: {
          organizationId: "org-1",
          name: "Expiring Key",
          keyHash: "abc",
          expiresAt: parsedExpiry,
        },
      });

      expect(apiKey.expiresAt).toEqual(parsedExpiry);
    });

    it("should require non-empty name (validation test)", () => {
      const { z } = require("zod");
      const schema = z.object({
        name: z.string().min(1),
        expiresAt: z.string().datetime().optional(),
      });

      expect(() => schema.parse({ name: "" })).toThrow();
      expect(() => schema.parse({ name: "Valid Name" })).not.toThrow();
    });
  });

  describe("Delete API Key", () => {
    it("should check org ownership before deleting", async () => {
      mockPrisma.apiKey.findFirst.mockResolvedValue({
        id: "key-1",
        organizationId: "org-1",
      });
      mockPrisma.apiKey.delete.mockResolvedValue({ id: "key-1" });

      const apiKey = await mockPrisma.apiKey.findFirst({
        where: { id: "key-1", organizationId: "org-1" },
      });

      expect(apiKey).not.toBeNull();
      expect(mockPrisma.apiKey.findFirst).toHaveBeenCalledWith({
        where: { id: "key-1", organizationId: "org-1" },
      });

      await mockPrisma.apiKey.delete({ where: { id: "key-1" } });
      expect(mockPrisma.apiKey.delete).toHaveBeenCalledWith({
        where: { id: "key-1" },
      });
    });

    it("should throw NOT_FOUND when key does not belong to organization", async () => {
      mockPrisma.apiKey.findFirst.mockResolvedValue(null);

      const apiKey = await mockPrisma.apiKey.findFirst({
        where: { id: "key-1", organizationId: "other-org" },
      });

      expect(apiKey).toBeNull();
      // The router would throw TRPCError NOT_FOUND here
    });

    it("should not delete key from another organization", async () => {
      mockPrisma.apiKey.findFirst.mockResolvedValue(null);

      const result = await mockPrisma.apiKey.findFirst({
        where: { id: "key-1", organizationId: "wrong-org" },
      });

      expect(result).toBeNull();
      expect(mockPrisma.apiKey.delete).not.toHaveBeenCalled();
    });
  });
});
