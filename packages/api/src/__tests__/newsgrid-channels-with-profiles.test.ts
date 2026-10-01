/**
 * newsgrid.channelsWithProfiles must return only the NewsGrid brand profile, not
 * the raw `channel.metadata` (security review 2026-10-01).
 *
 * channel.metadata is shared with the platform integrations: for Discord it holds
 * the webhook URL (a full posting credential, in plaintext), for Facebook the
 * userAccessToken, for Telegram the chat id, plus internal bookkeeping such as
 * insightsHealth. The NewsGrid pages read only the brand-profile keys.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { channelFindMany, prismaMock } = vi.hoisted(() => {
  const channelFindMany = vi.fn(async (..._a: any[]) => [] as any[]);
  return {
    channelFindMany,
    prismaMock: {
      organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })) },
      organization: { findUnique: vi.fn(async () => null) },
      channel: { findMany: (...a: any[]) => channelFindMany(...a) },
    },
  };
});

vi.mock("@postautomation/queue", () => ({ postPublishQueue: { add: vi.fn() } }));
vi.mock("@postautomation/db", () => ({ prisma: prismaMock, ensurePersonalOrg: vi.fn() }));

import { createCallerFactory } from "../trpc";
import { newsgridRouter } from "../routers/newsgrid.router";

const caller = () =>
  createCallerFactory(newsgridRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: { user: { id: "u1", email: "u@x.com", isSuperAdmin: false, appRole: "ADMIN" }, expires: "2099-01-01" } as any,
  } as any);

const PROFILE = {
  logo_path: "https://cdn.example/logo.png",
  font_family: "Roboto",
  brand_palette: "gold",
  caption_style: "editorial",
  template_type: "cinematic",
  logo_position: "bottom_center",
  username_position: "below_logo",
  language_style: "EN",
};

beforeEach(() => vi.clearAllMocks());

describe("newsgrid.channelsWithProfiles", () => {
  it("returns the brand profile and never a credential or internal metadata key", async () => {
    channelFindMany.mockResolvedValueOnce([
      {
        id: "ch-discord",
        name: "Discord",
        username: null,
        platform: "DISCORD",
        avatar: null,
        metadata: { ...PROFILE, webhookUrl: "https://discord.com/api/webhooks/1/SECRET-WEBHOOK" },
      },
      {
        id: "ch-fb",
        name: "FB Page",
        username: "page",
        platform: "FACEBOOK",
        avatar: null,
        metadata: {
          pageId: "123",
          userAccessToken: "enc:v1:CIPHERTEXT",
          insightsHealth: { status: "ok" },
          grantedScopes: ["pages_manage_posts"],
          caption_style: "bold",
        },
      },
      {
        id: "ch-tg",
        name: "Telegram",
        username: null,
        platform: "TELEGRAM",
        avatar: null,
        metadata: { chatId: "-100123", instance: "x", service: "y" },
      },
    ]);

    const res = await caller().channelsWithProfiles();
    const text = JSON.stringify(res);
    for (const needle of [
      "webhookUrl",
      "SECRET-WEBHOOK",
      "userAccessToken",
      "enc:v1:",
      "chatId",
      "-100123",
      "pageId",
      "insightsHealth",
      "grantedScopes",
      "instance",
      "service",
    ]) {
      expect(text).not.toContain(needle);
    }

    expect(res[0]).toEqual({ id: "ch-discord", name: "Discord", username: null, platform: "DISCORD", avatar: null, metadata: PROFILE });
    expect(res[1]!.metadata).toEqual({ caption_style: "bold" });
    expect(res[2]!.metadata).toEqual({});
  });

  it("handles channels with no metadata", async () => {
    channelFindMany.mockResolvedValueOnce([
      { id: "ch-1", name: "A", username: null, platform: "X", avatar: null, metadata: null },
      { id: "ch-2", name: "B", username: null, platform: "X", avatar: null, metadata: ["not", "an", "object"] },
    ]);
    const res = await caller().channelsWithProfiles();
    expect(res.map((c) => c.metadata)).toEqual([{}, {}]);
  });
});
