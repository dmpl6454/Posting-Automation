import { describe, it, expect, vi } from "vitest";
import { resolveUploadOrganizationId } from "./upload-org";

function db(memberOf: string[], defaultOrg: string | null) {
  return {
    organizationMember: {
      findUnique: vi.fn(async (args: any) => {
        const { userId, organizationId } = args.where.userId_organizationId;
        return userId === "user-1" && memberOf.includes(organizationId) ? { organizationId } : null;
      }),
      findFirst: vi.fn(async (..._a: any[]) => (defaultOrg ? { organizationId: defaultOrg } : null)),
    },
  };
}

describe("resolveUploadOrganizationId", () => {
  it("uses the header org only after a real membership check", async () => {
    const prisma = db(["org-a", "org-b"], "org-a");
    await expect(resolveUploadOrganizationId(prisma, "user-1", "org-b")).resolves.toBe("org-b");
    expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
      where: { userId_organizationId: { userId: "user-1", organizationId: "org-b" } },
      select: { organizationId: true },
    });
    expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
  });

  it("never files into a header org the user does not belong to", async () => {
    const prisma = db(["org-a"], "org-a");
    await expect(resolveUploadOrganizationId(prisma, "user-1", "org-foreign")).resolves.toBe("org-a");
  });

  it("falls back deterministically, matching orgProcedure (OWNER first, then oldest)", async () => {
    const prisma = db(["org-a"], "org-a");
    await expect(resolveUploadOrganizationId(prisma, "user-1", null)).resolves.toBe("org-a");
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.organizationMember.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: { organizationId: true },
    });
  });

  it("treats an empty header as absent", async () => {
    const prisma = db(["org-a"], "org-a");
    await expect(resolveUploadOrganizationId(prisma, "user-1", "")).resolves.toBe("org-a");
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when the user has no membership at all", async () => {
    await expect(resolveUploadOrganizationId(db([], null), "user-1", null)).resolves.toBeNull();
  });
});

describe("/api/upload route uses the shared resolver", () => {
  it("does not run its own (unordered) membership lookup", async () => {
    const { readSourceWithoutComments } = await import("./source-lock");
    const src = readSourceWithoutComments("apps/web/app/api/upload/route.ts");
    expect(src).toMatch(/resolveUploadOrganizationId\(\s*prisma,\s*userId,\s*req\.headers\.get\("x-organization-id"\)\s*\)/);
    expect(src).not.toMatch(/organizationMember\.findFirst/);
  });
});
