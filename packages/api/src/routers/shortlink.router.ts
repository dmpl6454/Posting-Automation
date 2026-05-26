import crypto from "crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";

// SECURITY: every endpoint is org-scoped via `orgProcedure` and looks up
// short links with `organizationId: ctx.organizationId`. Previously
// `findUnique({ where: { id } })` allowed any logged-in user to read
// click analytics or delete other tenants' short links.

// Fix #45: lightweight UA parsing (no extra dependency). Good-enough buckets
// for analytics; not intended for security-sensitive use.
function parseUA(ua: string | null | undefined): {
  device: "desktop" | "mobile" | "tablet" | "bot";
  browser: string;
  os: string;
} {
  const s = (ua ?? "").toLowerCase();
  if (!s) return { device: "desktop", browser: "Unknown", os: "Unknown" };

  // Bots / crawlers
  if (/bot|crawler|spider|crawl|preview|fetcher|monitor|pingdom|uptime|slackbot|discordbot|facebookexternalhit|twitterbot/i.test(s)) {
    return { device: "bot", browser: "Bot", os: "Bot" };
  }

  // Device
  let device: "desktop" | "mobile" | "tablet" = "desktop";
  if (/ipad|tablet/.test(s)) device = "tablet";
  else if (/mobi|iphone|android.*mobile/.test(s)) device = "mobile";
  else if (/android/.test(s)) device = "tablet";

  // OS
  let os = "Unknown";
  if (/windows/.test(s)) os = "Windows";
  else if (/iphone|ipad|ipod/.test(s)) os = "iOS";
  else if (/mac os|macintosh/.test(s)) os = "macOS";
  else if (/android/.test(s)) os = "Android";
  else if (/linux/.test(s)) os = "Linux";
  else if (/cros/.test(s)) os = "ChromeOS";

  // Browser
  let browser = "Unknown";
  if (/edg\//.test(s)) browser = "Edge";
  else if (/opr\//.test(s) || /opera/.test(s)) browser = "Opera";
  else if (/chrome\//.test(s)) browser = "Chrome";
  else if (/firefox/.test(s)) browser = "Firefox";
  else if (/safari/.test(s)) browser = "Safari";

  return { device, browser, os };
}

export const shortlinkRouter = createRouter({
  create: orgProcedure
    .input(
      z.object({
        originalUrl: z.string().url(),
        postId: z.string().optional(),
        expiresAt: z.string().datetime().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const code = crypto.randomBytes(4).toString("hex");

      const shortLink = await ctx.prisma.shortLink.create({
        data: {
          organizationId: ctx.organizationId,
          code,
          originalUrl: input.originalUrl,
          postId: input.postId,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
      });

      return shortLink;
    }),

  list: orgProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const links = await ctx.prisma.shortLink.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (links.length > input.limit) {
        const lastItem = links.pop();
        nextCursor = lastItem?.id;
      }

      return { links, nextCursor };
    }),

  getStats: orgProcedure
    .input(
      z.object({
        id: z.string(),
        // Fix #45: configurable lookback window (7 or 30 day toggle in UI)
        days: z.number().int().min(1).max(90).default(7),
      })
    )
    .query(async ({ ctx, input }) => {
      const shortLink = await ctx.prisma.shortLink.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!shortLink) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Short link not found" });
      }

      const since = new Date();
      since.setDate(since.getDate() - input.days);

      const clicks = await ctx.prisma.shortLinkClick.findMany({
        where: {
          shortLinkId: input.id,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
      });

      const clicksByDay: Record<string, number> = {};
      for (let i = 0; i < input.days; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const key = date.toISOString().split("T")[0] ?? "unknown";
        clicksByDay[key] = 0;
      }
      for (const click of clicks) {
        const key = click.createdAt.toISOString().split("T")[0] ?? "unknown";
        const currentCount = clicksByDay[key];
        if (currentCount !== undefined) {
          clicksByDay[key] = currentCount + 1;
        }
      }

      const bucket = <K extends string>(
        items: Array<K | null | undefined>,
        fallback: K
      ): Array<{ name: string; count: number }> => {
        const counts = new Map<string, number>();
        for (const item of items) {
          const k = String(item ?? fallback);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        return Array.from(counts.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
      };

      // Referers + countries (existing behaviour kept for backwards-compat)
      const topReferers = bucket(
        clicks.map((c) => c.referer as string | null),
        "Direct"
      ).map(({ name, count }) => ({ referer: name, count }));

      const topCountries = bucket(
        clicks.map((c) => c.country as string | null),
        "Unknown"
      ).map(({ name, count }) => ({ country: name, count }));

      // Fix #45: device / browser / OS breakdown via inline UA parser
      const parsed = clicks.map((c) => parseUA(c.userAgent));
      const devices = bucket(
        parsed.map((p) => p.device),
        "desktop"
      );
      const browsers = bucket(
        parsed.map((p) => p.browser),
        "Unknown"
      );
      const os = bucket(
        parsed.map((p) => p.os),
        "Unknown"
      );

      // Fix #45: clicks by hour-of-day (0-23)
      const hours = new Array(24).fill(0) as number[];
      for (const c of clicks) {
        hours[c.createdAt.getHours()] = (hours[c.createdAt.getHours()] ?? 0) + 1;
      }
      const clicksByHour = hours.map((count, hour) => ({ hour, count }));

      return {
        shortLink,
        clicksByDay: Object.entries(clicksByDay)
          .map(([date, count]) => ({ date, count }))
          .reverse(),
        topReferers,
        topCountries,
        devices,
        browsers,
        os,
        clicksByHour,
        totalClicks: shortLink.clicks,
        windowClicks: clicks.length,
        days: input.days,
      };
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const shortLink = await ctx.prisma.shortLink.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!shortLink) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Short link not found" });
      }
      await ctx.prisma.shortLink.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
