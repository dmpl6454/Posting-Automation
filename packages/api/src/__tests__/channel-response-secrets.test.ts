/**
 * No channel procedure may return platform credentials to the browser
 * (security audit 2026-09-28).
 *
 * packages/db's $extends decrypts accessToken / refreshToken on every DIRECT
 * channel read or write. `channel.toggleActive` returned `prisma.channel.update`
 * with no select, so any member of the workspace — including a MEMBER-role user
 * — could click a toggle and receive every platform's PLAINTEXT tokens. For an
 * Instagram channel that token is the Facebook USER token, which reaches every
 * Page its consent granted. `connectWithToken` returned the same kind of row.
 *
 * The mocks below deliberately return FULL rows carrying secrets, so the test
 * proves the procedures strip them in code, not merely that a `select` was sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: vi.fn(async () => undefined),
  requirePlan: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));

vi.mock("@postautomation/queue", () => ({
  avatarCacheQueue: { add: vi.fn(async () => {}) },
}));

vi.mock("../lib/channel-token-validators", () => ({
  TOKEN_PLATFORMS: ["TELEGRAM"],
  TOKEN_PLATFORM_SPECS: {},
  validateAndBuildChannel: vi.fn(async () => ({
    platformId: "chat-1",
    name: "My bot",
    username: "mybot",
    avatar: null,
    accessToken: "123456:SECRET-BOT-TOKEN",
    refreshToken: null,
    tokenExpiresAt: null,
    scopes: [],
    metadata: { chatId: "chat-1" },
  })),
}));

/** A row as the decrypting Prisma extension hands it back: secrets in plaintext. */
const secretRow = {
  id: "ch-1",
  organizationId: "org-1",
  platform: "INSTAGRAM",
  platformId: "17841400000000000",
  name: "Brand IG",
  username: "brand",
  avatar: "https://cdn.example/a.jpg",
  isActive: false,
  accessToken: "EAAB-PLAINTEXT-USER-TOKEN",
  refreshToken: "PLAINTEXT-REFRESH",
  tokenExpiresAt: null,
  scopes: ["instagram_basic"],
  metadata: { igUserId: "17841400000000000", userAccessToken: "enc:v1:CIPHERTEXT" },
  disconnectedAt: null,
  metaAppId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const channelFindFirst = vi.fn();
const channelUpdate = vi.fn();
const channelUpsert = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async () => ({ id: "m1", userId: "user-1", organizationId: "org-1", role: "MEMBER" })),
      findFirst: vi.fn(async () => ({ organizationId: "org-1" })),
    },
    organization: { findUnique: vi.fn(async () => ({ plan: "FREE", planExpiresAt: null })) },
    channel: {
      findFirst: (...a: any[]) => channelFindFirst(...a),
      update: (...a: any[]) => channelUpdate(...a),
      upsert: (...a: any[]) => channelUpsert(...a),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  },
  ensurePersonalOrg: vi.fn(),
  resolveChannelErrorsOnReconnect: vi.fn(async () => {}),
  DISCONNECTED_TOKEN: "__disconnected__",
}));

import { createCallerFactory } from "../trpc";
import { channelRouter } from "../routers/channel.router";
import { prisma as prismaMock } from "@postautomation/db";

const caller = () =>
  createCallerFactory(channelRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

/** Every credential-bearing name, anywhere in the serialized response. */
function assertNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const needle of [
    "accessToken",
    "refreshToken",
    "userAccessToken",
    "PLAINTEXT",
    "SECRET-BOT-TOKEN",
    "enc:v1:",
  ]) {
    expect(text).not.toContain(needle);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  channelFindFirst.mockResolvedValue({ ...secretRow });
  channelUpdate.mockImplementation(async (args: any) => ({ ...secretRow, ...args.data }));
  channelUpsert.mockResolvedValue({ ...secretRow, platform: "TELEGRAM", accessToken: "123456:SECRET-BOT-TOKEN" });
});

describe("channel.toggleActive", () => {
  it("returns the new state and NOTHING that could authenticate as the channel", async () => {
    const res = await caller().toggleActive({ channelId: "ch-1" });
    assertNoSecrets(res);
    expect(res).toMatchObject({ id: "ch-1", isActive: true });
  });

  it("asks the database for the safe columns only, so the tokens are never even decrypted", async () => {
    await caller().toggleActive({ channelId: "ch-1" });
    const select = channelUpdate.mock.calls[0]![0].select;
    expect(select).toBeDefined();
    expect(select.accessToken).toBeUndefined();
    expect(select.refreshToken).toBeUndefined();
    expect(select.metadata).toBeUndefined();
  });

  it("is still org-scoped", async () => {
    channelFindFirst.mockResolvedValueOnce(null);
    await expect(caller().toggleActive({ channelId: "foreign" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(channelUpdate).not.toHaveBeenCalled();
    expect(channelFindFirst.mock.calls[0]![0].where).toMatchObject({ organizationId: "org-1" });
  });
});

describe("channel.connectWithToken", () => {
  it("does not echo the stored credentials back", async () => {
    const res = await caller().connectWithToken({ platform: "TELEGRAM", credentials: { botToken: "x" } });
    assertNoSecrets(res);
    expect(res).toMatchObject({ id: "ch-1", platform: "TELEGRAM", name: "Brand IG" });
  });
});

describe("no router returns a full channel row through a relation", () => {
  it("every `include` of a channel uses PUBLIC_CHANNEL_SELECT", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(__dirname, "..", "routers");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          // Strip comments: a note that QUOTES the banned shape must not fail the lock.
          // Then strip `_count: { select: { ... } }` — there `channels: true` is a count.
          const src = readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "")
            .replace(/_count:\s*\{\s*select:\s*\{[^{}]*\}\s*,?\s*\}/g, "");
          // `channels: true` (the plural relation, e.g. on Organization) returns full rows too.
          if (/\bchannels?:\s*true\b/.test(src)) offenders.push(p.slice(dir.length + 1));
        }
      }
    };
    walk(dir);
    // Relation reads return token CIPHERTEXT plus `metadata` (userAccessToken) —
    // still credential material, and none of it is needed by any client.
    expect(offenders).toEqual([]);
  });
});
