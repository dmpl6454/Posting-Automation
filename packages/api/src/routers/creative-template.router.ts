import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { sanitizeCardSpecJson } from "../lib/sanitize-card-spec";

/** Validate an optional logo media id belongs to the org (IDOR guard). */
export async function assertLogoMediaOwned(
  prisma: any,
  organizationId: string,
  logoMediaId: string | undefined
): Promise<void> {
  if (!logoMediaId) return;
  const found = await prisma.media.findFirst({
    where: { id: logoMediaId, organizationId },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Logo media not found in this organization." });
  }
}

/** Validate an optional reference media id belongs to the org (IDOR guard). */
export async function assertReferenceMediaOwned(
  prisma: any,
  organizationId: string,
  referenceMediaId: string | undefined,
): Promise<void> {
  if (!referenceMediaId) return;
  const found = await prisma.media.findFirst({
    where: { id: referenceMediaId, organizationId },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Reference media not found in this organization." });
  }
}

// CardSpec is sanitized on READ (sanitizeCardSpecJson) and again by the renderer,
// so accept a permissive json blob on write — the store is never trusted raw.
const CARD_SPEC = z.any().optional();

const STYLE = z.enum(["premium_editorial", "hook_bars", "tweet_card", "bold_typographic"]);
const POSITION = z.enum(["top-left", "top-right"]);
const KIND = z.enum(["logo", "style", "name"]);

/** Derive a template's library kind from its inputs when not explicitly set:
 *  a "name" template is created explicitly (the on-card brand name to display);
 *  a saved STYLE has a reference image; everything else is a brand LOGO. */
export function deriveTemplateKind(input: { kind?: "logo" | "style" | "name"; referenceMediaId?: string }): "logo" | "style" | "name" {
  if (input.kind) return input.kind;
  return input.referenceMediaId ? "style" : "logo";
}

export const creativeTemplateRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.prisma.creativeTemplate.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      include: { logoMedia: { select: { url: true } }, referenceMedia: { select: { url: true } } },
    });
    // NEVER trust a stored cardSpec: re-sanitize every color/url before it leaves the API.
    return rows.map((r) => ({ ...r, cardSpec: r.cardSpec ? sanitizeCardSpecJson(r.cardSpec) : null }));
  }),

  getById: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.prisma.creativeTemplate.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: { logoMedia: { select: { url: true } }, referenceMedia: { select: { url: true } } },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { ...row, cardSpec: row.cardSpec ? sanitizeCardSpecJson(row.cardSpec) : null };
    }),

  create: orgProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        kind: KIND.optional(),
        // A "name" template only carries the on-card brand name (its `name`); style
        // is irrelevant for it, so default rather than require it.
        style: STYLE.default("premium_editorial"),
        logoMediaId: z.string().optional(),
        logoPosition: POSITION.default("top-right"),
        brandColor: z.string().optional(),
        channelId: z.string().optional(),
        referenceMediaId: z.string().optional(),
        cardSpec: CARD_SPEC,
        sourceUrl: z.string().url().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertLogoMediaOwned(ctx.prisma, ctx.organizationId, input.logoMediaId);
      await assertReferenceMediaOwned(ctx.prisma, ctx.organizationId, input.referenceMediaId);
      // Sanitize BEFORE storing too — store only clean JSON (defense in depth;
      // the read path re-sanitizes regardless).
      const cleanSpec = input.cardSpec ? sanitizeCardSpecJson(input.cardSpec) : null;
      return ctx.prisma.creativeTemplate.create({
        data: {
          organizationId: ctx.organizationId,
          createdById: (ctx.session.user as any).id,
          name: input.name,
          kind: deriveTemplateKind(input),
          style: input.style,
          logoMediaId: input.logoMediaId,
          logoPosition: input.logoPosition,
          brandColor: input.brandColor,
          channelId: input.channelId,
          referenceMediaId: input.referenceMediaId,
          cardSpec: cleanSpec ?? undefined,
          sourceUrl: input.sourceUrl,
        },
      });
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(80).optional(),
        kind: KIND.optional(),
        style: STYLE.optional(),
        logoMediaId: z.string().nullable().optional(),
        logoPosition: POSITION.optional(),
        brandColor: z.string().nullable().optional(),
        cardSpec: CARD_SPEC,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.creativeTemplate.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.logoMediaId) {
        await assertLogoMediaOwned(ctx.prisma, ctx.organizationId, input.logoMediaId);
      }
      return ctx.prisma.creativeTemplate.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.kind !== undefined && { kind: input.kind }),
          ...(input.style !== undefined && { style: input.style }),
          ...(input.logoMediaId !== undefined && { logoMediaId: input.logoMediaId }),
          ...(input.logoPosition !== undefined && { logoPosition: input.logoPosition }),
          ...(input.brandColor !== undefined && { brandColor: input.brandColor }),
          ...(input.cardSpec !== undefined && { cardSpec: sanitizeCardSpecJson(input.cardSpec) ?? undefined }),
        },
      });
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.creativeTemplate.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.creativeTemplate.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
