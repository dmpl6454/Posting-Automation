/**
 * Super-admin channel views must not ship platform credentials to the browser
 * (security review 2026-10-01, follow-up to channel-response-secrets.test.ts).
 *
 * admin.channels.list was a direct `channel.findMany` with no select — the db
 * extension decrypts accessToken/refreshToken on direct reads — and returned
 * `{ ...ch }`, so the admin console received EVERY org's plaintext tokens and
 * metadata (Discord webhook URLs, the Facebook user token behind IG channels).
 * admin.orgs.getById returned `channels: true`, i.e. full rows.
 *
 * The mocks return FULL rows carrying secrets, so these tests prove the
 * procedures strip them in code, not merely that a select was sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const channelFindMany = vi.fn(async (..._a: any[]) => [] as any[]);
const organizationFindUnique = vi.fn(async (..._a: any[]) => null as any);

vi.mock("@postautomation/db", () => ({
  prisma: {
    channel: { findMany: (...a: any[]) => channelFindMany(...a) },
    organization: { findUnique: (...a: any[]) => organizationFindUnique(...a) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { adminChannelsRouter } from "../routers/admin/channels.router";
import { adminOrgsRouter } from "../routers/admin/orgs.router";
import { PUBLIC_CHANNEL_SELECT } from "../lib/public-channel";
import { prisma as prismaMock } from "@postautomation/db";

const ctx = () =>
  ({
    prisma: prismaMock as any,
    session: { user: { id: "admin-1", email: "a@b.c", isSuperAdmin: true }, expires: "2099-01-01" } as any,
  }) as any;

const DAY = 24 * 60 * 60 * 1000;

/** A row as the decrypting extension hands it back: secrets in plaintext. */
function secretRow(over: Record<string, unknown> = {}) {
  return {
    id: "ch-1",
    organizationId: "org-1",
    platform: "DISCORD",
    platformId: "wh-1",
    name: "Brand Discord",
    username: "brand",
    avatar: null,
    isActive: true,
    accessToken: "PLAINTEXT-ACCESS",
    refreshToken: "PLAINTEXT-REFRESH",
    tokenExpiresAt: new Date(Date.now() + 30 * DAY),
    scopes: ["x"],
    metadata: {
      webhookUrl: "https://discord.com/api/webhooks/1/SECRET-WEBHOOK",
      userAccessToken: "enc:v1:CIPHERTEXT",
    },
    disconnectedAt: null,
    metaAppId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    organization: { id: "org-1", name: "Acme", stripeCustomerId: "cus_SECRET" },
    ...over,
  };
}

function assertNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const needle of [
    '"accessToken"',
    '"refreshToken"',
    '"metadata"',
    '"scopes"',
    "userAccessToken",
    "webhookUrl",
    "PLAINTEXT",
    "SECRET",
    "enc:v1:",
  ]) {
    expect(text).not.toContain(needle);
  }
}

beforeEach(() => vi.clearAllMocks());

describe("admin.channels.list", () => {
  it("returns no credential material even when the database hands back full rows", async () => {
    channelFindMany.mockResolvedValueOnce([secretRow()]);
    const res = await createCallerFactory(adminChannelsRouter)(ctx()).list({ limit: 20 });
    assertNoSecrets(res);
  });

  it("still returns every field the admin channels page reads", async () => {
    channelFindMany.mockResolvedValueOnce([
      secretRow(),
      secretRow({ id: "ch-2", refreshToken: null, tokenExpiresAt: new Date(Date.now() - DAY) }),
      secretRow({ id: "ch-3", tokenExpiresAt: new Date(Date.now() + DAY) }),
      secretRow({ id: "ch-4", tokenExpiresAt: null }),
    ]);
    const { items } = await createCallerFactory(adminChannelsRouter)(ctx()).list({ limit: 20 });
    expect(items[0]).toMatchObject({
      id: "ch-1",
      name: "Brand Discord",
      platform: "DISCORD",
      tokenStatus: "valid",
      hasRefreshToken: true,
      organization: { id: "org-1", name: "Acme" },
    });
    expect(items[0]!.createdAt).toBeInstanceOf(Date);
    expect(items.map((i) => i.tokenStatus)).toEqual(["valid", "expired", "expiring", "unknown"]);
    expect(items.map((i) => i.hasRefreshToken)).toEqual([true, false, true, true]);
  });

  it("does not ask the database for the access token or metadata", async () => {
    await createCallerFactory(adminChannelsRouter)(ctx()).list({ limit: 20 });
    const args = channelFindMany.mock.calls[0]![0];
    expect(args.include).toBeUndefined();
    expect(args.select).toBeDefined();
    expect(args.select.accessToken).toBeUndefined();
    expect(args.select.metadata).toBeUndefined();
    expect(args.select.organization).toEqual({ select: { id: true, name: true } });
  });

  it("keeps cursor pagination working", async () => {
    channelFindMany.mockResolvedValueOnce([secretRow(), secretRow({ id: "ch-2" }), secretRow({ id: "ch-3" })]);
    const res = await createCallerFactory(adminChannelsRouter)(ctx()).list({ limit: 2 });
    expect(res.items.map((i) => i.id)).toEqual(["ch-1", "ch-2"]);
    expect(res.nextCursor).toBe("ch-3");
  });
});

describe("admin.orgs.getById", () => {
  it("loads the org's channels through PUBLIC_CHANNEL_SELECT and returns no credentials", async () => {
    organizationFindUnique.mockResolvedValueOnce({
      id: "org-1",
      name: "Acme",
      members: [],
      posts: [],
      channels: [secretRow()],
    });
    const res = await createCallerFactory(adminOrgsRouter)(ctx()).getById({ id: "org-1" });
    const args = organizationFindUnique.mock.calls[0]![0];
    expect(args.include.channels).toEqual({ select: PUBLIC_CHANNEL_SELECT });
    assertNoSecrets(res.channels);
    expect(res.channels[0]).toMatchObject({ id: "ch-1", name: "Brand Discord", platform: "DISCORD" });
  });
});
