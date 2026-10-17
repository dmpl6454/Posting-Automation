import { describe, it, expect, vi } from "vitest";

vi.mock("@postautomation/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/db")>();
  return { ...actual, prisma: {} };
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { subscribeConnectedPages, planPageSubscriptions, pageSubscriptionWanted } from "../lib/page-subscriptions";

describe("page subscriptions after connect", () => {
  it("is skipped only when the grant is KNOWN to lack pages_manage_metadata", () => {
    expect(pageSubscriptionWanted(undefined)).toBe(true);
    expect(pageSubscriptionWanted(["pages_show_list"])).toBe(false);
    expect(pageSubscriptionWanted(["pages_manage_metadata"])).toBe(true);
  });

  it("merges entries for the same Page and drops tokenless ones", () => {
    expect(
      planPageSubscriptions([
        { pageId: "1", pageAccessToken: "a", channelIds: ["c1"] },
        { pageId: "1", pageAccessToken: "a", channelIds: ["c2", "c1"] },
        { pageId: "2", pageAccessToken: undefined, channelIds: ["c3"] },
      ])
    ).toEqual([{ pageId: "1", pageAccessToken: "a", channelIds: ["c1", "c2"] }]);
  });

  it("subscribes each Page once and merges the outcome into every dependent channel", async () => {
    const writes: Array<{ patch: string; id: string }> = [];
    const prisma = {
      $executeRaw: vi.fn(async (_s: TemplateStringsArray, patch: string, id: string) => {
        writes.push({ patch, id });
        return 1;
      }),
    };
    const subscribe = vi.fn(async (i: any) => ({ pageId: i.pageId, status: "subscribed" as const }));
    const r = await subscribeConnectedPages(
      [
        { pageId: "1", pageAccessToken: "a", channelIds: ["c1"] },
        { pageId: "1", pageAccessToken: "a", channelIds: ["c2"] },
      ],
      "APP",
      ["pages_manage_metadata"],
      { prisma, subscribe, now: () => new Date("2026-10-17T15:00:00Z") }
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith({ pageId: "1", pageAccessToken: "a", appId: "APP" });
    expect(r).toEqual([{ pageId: "1", status: "subscribed" }]);
    expect(writes.map((w) => w.id).sort()).toEqual(["c1", "c2"]);
    expect(JSON.parse(writes[0]!.patch)).toEqual({ pageSubscription: { status: "subscribed", at: "2026-10-17T15:00:00.000Z" } });
    // The token never reaches the channel row.
    expect(writes.some((w) => w.patch.includes('"a"'))).toBe(false);
  });

  it("does nothing without the permission, and never throws", async () => {
    const subscribe = vi.fn();
    await expect(
      subscribeConnectedPages([{ pageId: "1", pageAccessToken: "a", channelIds: ["c1"] }], "APP", ["pages_show_list"], {
        subscribe: subscribe as any,
        prisma: { $executeRaw: vi.fn() },
      })
    ).resolves.toEqual([]);
    expect(subscribe).not.toHaveBeenCalled();

    const broken = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      subscribeConnectedPages([{ pageId: "1", pageAccessToken: "a", channelIds: ["c1"] }], "APP", undefined, {
        subscribe: broken as any,
        prisma: { $executeRaw: vi.fn() },
      })
    ).resolves.toEqual([]);
  });

  it("the OAuth callback fires it for BOTH Facebook Pages and Instagram accounts, without awaiting", () => {
    const src = readFileSync(
      join(__dirname, "../../../../apps/web/app/api/oauth/callback/[provider]/route.ts"),
      "utf8"
    );
    expect(src.match(/queuePageSubscriptions\(\s*\n?\s*(fb|ig)Subscriptions/g)?.length).toBe(2);
    expect(src).toMatch(/void subscribeConnectedPages\(/);
    expect(src).not.toMatch(/await subscribeConnectedPages\(/);
  });
});
