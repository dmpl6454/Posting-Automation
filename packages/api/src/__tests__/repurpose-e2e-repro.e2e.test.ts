/**
 * REPRO: end-to-end "post created but contains no image" + "preview broken after
 * create post". Runs the REAL repurposeFromUrl resolver as the superadmin against
 * real DB + MinIO + AI + Puppeteer, then EXERCISES THE EXACT UI PATH:
 *   generate -> collect mediaIds (carouselMediaIds || mediaMap) -> post.create
 *   -> read post back -> assert mediaAttachments linked AND each media.url is
 *   actually HTTP-fetchable (the "preview <img src>" test).
 *
 * Gated on LIVE_E2E=1. Cleans up the posts it creates.
 *
 * Run: LIVE_E2E=1 pnpm --filter @postautomation/api exec vitest run \
 *        src/__tests__/repurpose-e2e-repro.e2e.test.ts
 */
import { describe, it, expect } from "vitest";
import { createCallerFactory } from "../trpc";
import { appRouter } from "../root";
import { prisma } from "@postautomation/db";

const LIVE = process.env.LIVE_E2E === "1" && !!process.env.OPENAI_API_KEY;
const d = LIVE ? describe : describe.skip;

const SUPERADMIN_EMAIL = process.env.E2E_EMAIL || "tabish@dashmani.com";
const TEST_URL = process.env.E2E_URL || "https://indianexpress.com/";

const createCaller = createCallerFactory(appRouter);

async function superadminCaller() {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: SUPERADMIN_EMAIL } });
  const membership = await prisma.organizationMember.findFirstOrThrow({
    where: { userId: user.id },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  return {
    caller: createCaller({
      prisma,
      session: { user: { id: user.id, email: user.email, isSuperAdmin: true } } as any,
      organizationId: membership.organizationId,
    }),
    orgId: membership.organizationId,
    userId: user.id,
  };
}

/** Mirror the RepurposeTab "Create Drafts" mediaIds collection exactly. */
function collectMediaIds(res: any): string[] {
  const mediaIds: string[] = [];
  if (res.carouselMediaIds && res.carouselMediaIds.length > 0) {
    mediaIds.push(...res.carouselMediaIds);
  } else if (res.mediaMap) {
    const seen = new Set<string>();
    for (const m of Object.values(res.mediaMap) as Array<{ mediaId?: string }>) {
      if (m.mediaId && !seen.has(m.mediaId)) {
        mediaIds.push(m.mediaId);
        seen.add(m.mediaId);
      }
    }
  }
  return mediaIds;
}

async function httpStatus(url: string): Promise<{ status: number; len: number; type: string | null }> {
  try {
    const r = await fetch(url);
    const buf = await r.arrayBuffer();
    return { status: r.status, len: buf.byteLength, type: r.headers.get("content-type") };
  } catch (e) {
    return { status: -1, len: 0, type: String((e as Error).message) };
  }
}

const FORMATS: Array<{ name: string; input: any }> = [
  {
    name: "static / premium_editorial",
    input: { format: "static", creativeStyle: "premium_editorial" },
  },
  {
    name: "static / hook_bars",
    input: { format: "static", creativeStyle: "hook_bars" },
  },
  {
    name: "postcard_grid (UI 'postcard')",
    input: { format: "static", creativeStyle: "postcard_grid", gridPreset: "two_up" },
  },
  {
    name: "carousel",
    input: { format: "carousel", creativeStyle: "premium_editorial", slideCount: 3 },
  },
];

d("Repurpose e2e repro — generate -> create post -> view image", () => {
  for (const f of FORMATS) {
    it(`${f.name}: media produced, fetchable, and linked to created post`, async () => {
      const { caller, orgId } = await superadminCaller();

      const res: any = await caller.repurpose.repurposeFromUrl({
        url: TEST_URL,
        targetPlatforms: ["INSTAGRAM", "TWITTER"],
        provider: "openai",
        channelName: "Repro Channel",
        channelHandle: "reprochannel",
        ...f.input,
      });

      console.log(
        `\n  [${f.name}] mediaFailed=${res.mediaFailed} ` +
          `mediaUrls=${res.mediaUrls?.length} ` +
          `carouselMediaIds=${res.carouselMediaIds?.length ?? 0} ` +
          `mediaMap=${res.mediaMap ? Object.keys(res.mediaMap).join(",") : "none"} ` +
          `bgSource=${res.bgSource}`,
      );

      // 1) media actually produced
      expect(res.mediaFailed).toBe(false);
      expect(res.mediaUrls.length).toBeGreaterThan(0);

      // 2) the returned URL is HTTP-fetchable exactly as a browser <img> would (THE PREVIEW TEST)
      const urlCheck = await httpStatus(res.mediaUrls[0]);
      console.log(`  [${f.name}] preview-url ${res.mediaUrls[0]} -> HTTP ${urlCheck.status} ${urlCheck.len}b ${urlCheck.type}`);
      expect(urlCheck.status).toBe(200);
      expect(urlCheck.len).toBeGreaterThan(1000);

      // 3) collect mediaIds the SAME way the UI does, and create a post
      const mediaIds = collectMediaIds(res);
      console.log(`  [${f.name}] collected mediaIds=${mediaIds.length} -> ${mediaIds.join(",")}`);
      expect(mediaIds.length).toBeGreaterThan(0);

      const post: any = await caller.post.create({
        content: (Object.values(res.platformContent)[0] as string) || "repro",
        contentVariants: res.platformContent,
        channelIds: [], // channel-less draft (savable; isolates media linking)
        mediaIds,
        aiGenerated: true,
        aiProvider: "openai",
      });

      // 4) read the post back and confirm the media is linked + fetchable (THE "VIEW POST" TEST)
      const got = await prisma.post.findUniqueOrThrow({
        where: { id: post.id },
        include: { mediaAttachments: { include: { media: true } } },
      });
      console.log(`  [${f.name}] created post ${post.id} attachments=${got.mediaAttachments.length}`);
      expect(got.mediaAttachments.length).toBe(mediaIds.length);

      for (const att of got.mediaAttachments) {
        const c = await httpStatus(att.media.url);
        console.log(`  [${f.name}] post media ${att.media.url} -> HTTP ${c.status} ${c.len}b`);
        expect(att.media.url).toMatch(/^https?:\/\//);
        expect(c.status).toBe(200);
      }

      // cleanup
      await prisma.post.delete({ where: { id: post.id } }).catch(() => {});
      expect(orgId).toBeTruthy();
    }, 240_000);
  }
});
