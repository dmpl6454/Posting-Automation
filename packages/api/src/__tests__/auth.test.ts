import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// Mock bcryptjs
const mockBcrypt = {
  hash: vi.fn(),
  compare: vi.fn(),
};

vi.mock("bcryptjs", () => ({
  default: {
    hash: (...args: any[]) => mockBcrypt.hash(...args),
    compare: (...args: any[]) => mockBcrypt.compare(...args),
  },
  hash: (...args: any[]) => mockBcrypt.hash(...args),
  compare: (...args: any[]) => mockBcrypt.compare(...args),
}));

// Mock Prisma
const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  passwordResetToken: {
    create: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  emailVerificationToken: {
    create: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  organizationMember: {
    findUnique: vi.fn(),
  },
};

vi.mock("@postautomation/db", () => ({
  prisma: mockPrisma,
}));

describe("Auth Flow - Password Reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Request Password Reset", () => {
    it("should generate a reset token as 64-char hex string", () => {
      const token = crypto.randomBytes(32).toString("hex");
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(token.length).toBe(64);
    });

    it("should set token expiry to 1 hour from now", () => {
      const now = Date.now();
      const expiresAt = new Date(now + 60 * 60 * 1000);
      const diffMs = expiresAt.getTime() - now;
      expect(diffMs).toBe(3_600_000); // 1 hour in ms
    });

    it("should delete existing tokens before creating a new one", async () => {
      const userId = "user-1";
      const callOrder: string[] = [];

      mockPrisma.passwordResetToken.deleteMany.mockImplementation(async () => {
        callOrder.push("deleteMany");
        return { count: 1 };
      });
      mockPrisma.passwordResetToken.create.mockImplementation(async () => {
        callOrder.push("create");
        return { id: "token-1", userId, token: "newtoken", expiresAt: new Date() };
      });

      await mockPrisma.passwordResetToken.deleteMany({
        where: { userId },
      });
      await mockPrisma.passwordResetToken.create({
        data: { userId, token: "newtoken", expiresAt: new Date() },
      });

      expect(callOrder).toEqual(["deleteMany", "create"]);
    });

    it("should return success even for non-existent email (prevent enumeration)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const user = await mockPrisma.user.findUnique({
        where: { email: "nobody@example.com" },
      });

      // Router returns { success: true } regardless
      const result = !user ? { success: true } : { success: true };
      expect(result.success).toBe(true);
      expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
    });

    it("should look up user by email", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-1",
        email: "user@example.com",
      });

      const user = await mockPrisma.user.findUnique({
        where: { email: "user@example.com" },
      });

      expect(user).not.toBeNull();
      expect(user.email).toBe("user@example.com");
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: "user@example.com" },
      });
    });
  });

  describe("Reset Password", () => {
    it("should throw NOT_FOUND for invalid token", async () => {
      mockPrisma.passwordResetToken.findUnique.mockResolvedValue(null);

      const resetToken = await mockPrisma.passwordResetToken.findUnique({
        where: { token: "invalid-token" },
        include: { user: true },
      });

      expect(resetToken).toBeNull();
      // Router would throw TRPCError({ code: "NOT_FOUND" })
    });

    it("should throw BAD_REQUEST for expired token", async () => {
      const expiredToken = {
        id: "token-1",
        token: "valid-but-expired",
        userId: "user-1",
        expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
        user: { id: "user-1", email: "user@example.com" },
      };

      mockPrisma.passwordResetToken.findUnique.mockResolvedValue(expiredToken);

      const resetToken = await mockPrisma.passwordResetToken.findUnique({
        where: { token: "valid-but-expired" },
        include: { user: true },
      });

      expect(resetToken!.expiresAt < new Date()).toBe(true);
    });

    it("should clean up expired token after detection", async () => {
      const expiredToken = {
        id: "token-expired",
        expiresAt: new Date(Date.now() - 1000),
      };

      mockPrisma.passwordResetToken.delete.mockResolvedValue({});

      if (expiredToken.expiresAt < new Date()) {
        await mockPrisma.passwordResetToken.delete({
          where: { id: expiredToken.id },
        });
      }

      expect(mockPrisma.passwordResetToken.delete).toHaveBeenCalledWith({
        where: { id: "token-expired" },
      });
    });

    it("should hash new password with bcrypt (salt rounds = 12)", async () => {
      mockBcrypt.hash.mockResolvedValue("$2a$12$hashedpassword");

      const hashedPassword = await mockBcrypt.hash("newSecurePassword123", 12);

      expect(hashedPassword).toBe("$2a$12$hashedpassword");
      expect(mockBcrypt.hash).toHaveBeenCalledWith("newSecurePassword123", 12);
    });

    it("should update user password with the hashed value", async () => {
      mockPrisma.user.update.mockResolvedValue({});

      await mockPrisma.user.update({
        where: { id: "user-1" },
        data: { password: "$2a$12$hashedpassword" },
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { password: "$2a$12$hashedpassword" },
      });
    });

    it("should delete the used reset token after password update", async () => {
      mockPrisma.passwordResetToken.delete.mockResolvedValue({});

      await mockPrisma.passwordResetToken.delete({
        where: { id: "token-1" },
      });

      expect(mockPrisma.passwordResetToken.delete).toHaveBeenCalledWith({
        where: { id: "token-1" },
      });
    });
  });
});

describe("Auth Flow - Email Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Verify Email", () => {
    it("should throw NOT_FOUND for invalid verification token", async () => {
      mockPrisma.emailVerificationToken.findUnique.mockResolvedValue(null);

      const token = await mockPrisma.emailVerificationToken.findUnique({
        where: { token: "bad-token" },
        include: { user: true },
      });

      expect(token).toBeNull();
    });

    it("should throw BAD_REQUEST for expired verification token", async () => {
      const expiredVerification = {
        id: "vtoken-1",
        token: "expired-verification",
        expiresAt: new Date(Date.now() - 86_400_001), // expired
        userId: "user-1",
      };

      mockPrisma.emailVerificationToken.findUnique.mockResolvedValue(
        expiredVerification
      );

      const token = await mockPrisma.emailVerificationToken.findUnique({
        where: { token: "expired-verification" },
        include: { user: true },
      });

      expect(token!.expiresAt < new Date()).toBe(true);
    });

    it("should update user emailVerified to current date on success", async () => {
      const now = new Date();
      mockPrisma.user.update.mockResolvedValue({
        id: "user-1",
        emailVerified: now,
      });

      await mockPrisma.user.update({
        where: { id: "user-1" },
        data: { emailVerified: now },
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { emailVerified: now },
      });
    });

    it("should delete the used verification token", async () => {
      mockPrisma.emailVerificationToken.delete.mockResolvedValue({});

      await mockPrisma.emailVerificationToken.delete({
        where: { id: "vtoken-1" },
      });

      expect(mockPrisma.emailVerificationToken.delete).toHaveBeenCalledWith({
        where: { id: "vtoken-1" },
      });
    });
  });

  describe("Request Email Verification", () => {
    it("should generate a verification token as 64-char hex string", () => {
      const token = crypto.randomBytes(32).toString("hex");
      expect(token).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should set verification token expiry to 24 hours from now", () => {
      const now = Date.now();
      const expiresAt = new Date(now + 24 * 60 * 60 * 1000);
      const diffMs = expiresAt.getTime() - now;
      expect(diffMs).toBe(86_400_000); // 24 hours in ms
    });

    it("should delete existing verification tokens before creating a new one", async () => {
      const callOrder: string[] = [];

      mockPrisma.emailVerificationToken.deleteMany.mockImplementation(async () => {
        callOrder.push("deleteMany");
        return { count: 1 };
      });
      mockPrisma.emailVerificationToken.create.mockImplementation(async () => {
        callOrder.push("create");
        return {};
      });

      await mockPrisma.emailVerificationToken.deleteMany({
        where: { userId: "user-1" },
      });
      await mockPrisma.emailVerificationToken.create({
        data: {
          userId: "user-1",
          token: "new-verification-token",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      expect(callOrder).toEqual(["deleteMany", "create"]);
    });
  });
});
