/**
 * chat.createThread must org-scope agentId (security audit 2026-09-28,
 * low-severity but cheap to close): it was written into the new thread's
 * foreign key with no check that the agent belongs to the caller's org.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@postautomation/queue", () => ({
  agentRunQueue: { add: vi.fn(async () => {}) },
  postPublishQueue: { add: vi.fn(async () => {}) },
  captionFanoutQueue: { add: vi.fn(async () => {}) },
}));

const agentFindFirst = vi.fn();
const chatThreadCreate = vi.fn(async (a: any) => ({ id: "t1", ...a.data }));

vi.mock("@postautomation/db", () => ({
  prisma: {
    agent: { findFirst: (a: any) => agentFindFirst(a) },
    chatThread: { create: (a: any) => chatThreadCreate(a) },
    organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })) },
    organization: { findUnique: vi.fn(async () => null) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { chatRouter } from "../routers/chat.router";

function caller() {
  return createCallerFactory(chatRouter)({
    prisma: {
      agent: { findFirst: (a: any) => agentFindFirst(a) },
      chatThread: { create: (a: any) => chatThreadCreate(a) },
      organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })) },
      organization: { findUnique: vi.fn(async () => null) },
    } as any,
    organizationId: "org-1",
    session: { user: { id: "u1", email: "u@x.com", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  } as any);
}

beforeEach(() => vi.clearAllMocks());

describe("chat.createThread — agentId", () => {
  it("refuses to link a thread to an agent that belongs to a different org", async () => {
    agentFindFirst.mockResolvedValue(null);
    await expect(caller().createThread({ agentId: "foreign-agent" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(chatThreadCreate).not.toHaveBeenCalled();
  });

  it("still creates a thread for an owned agent", async () => {
    agentFindFirst.mockResolvedValue({ id: "own-agent" });
    await expect(caller().createThread({ agentId: "own-agent" })).resolves.toBeDefined();
    expect(chatThreadCreate).toHaveBeenCalledTimes(1);
  });

  it("still creates a thread with no agentId at all (unaffected)", async () => {
    await expect(caller().createThread({})).resolves.toBeDefined();
    expect(agentFindFirst).not.toHaveBeenCalled();
  });
});
