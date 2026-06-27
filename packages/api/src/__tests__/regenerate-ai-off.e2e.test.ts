/**
 * REPRO: regenerateImage produces an AI image even though the user had the AI
 * toggle OFF. The mimicry branch passes deterministicOnly:true (block engine,
 * no AI), but when generateLayoutExtractCard returns null it signals
 * engine:"template" → the router throws → falls to renderStaticCreative WITHOUT
 * aiEnabled:false → generateImageSafe runs → AI background. regenerate has NO
 * aiImages plumbing at all.
 *
 * This LIVE e2e calls the real regenerateImage as superadmin with referenceMimicry
 * on + a reference + the article hero, and asserts the result is NOT an AI image
 * (bgSource must be "real", imageEngine null). Gated on LIVE_E2E=1.
 *
 * Run: LIVE_E2E=1 pnpm --filter @postautomation/api exec vitest run src/__tests__/regenerate-ai-off.e2e.test.ts
 */
import { describe, it, expect } from "vitest";
import { createCallerFactory } from "../trpc";
import { appRouter } from "../root";
import { prisma } from "@postautomation/db";

const LIVE = process.env.LIVE_E2E === "1" && !!process.env.OPENAI_API_KEY;
const d = LIVE ? describe : describe.skip;
const SUPERADMIN_EMAIL = process.env.E2E_EMAIL || "tabish@dashmani.com";
const createCaller = createCallerFactory(appRouter);

// A public reference image (any image works to trigger the mimicry branch) + the
// HT article hero. Env-overridable.
const REF_URL = process.env.E2E_REF_URL ||
  "https://www.hindustantimes.com/ht-img/img/2026/06/26/550x309/IRAN-CRISIS-LEBANON-ISRAEL-13_1782506050259_1782506059225_511aaa5e-7c88-43c1-88b9-56c244b2d1b7.JPG";
const HERO_URL = process.env.E2E_HERO_URL || REF_URL;

async function superadminCaller() {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: SUPERADMIN_EMAIL } });
  const membership = await prisma.organizationMember.findFirstOrThrow({
    where: { userId: user.id },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  return createCaller({
    prisma,
    session: { user: { id: user.id, email: user.email, isSuperAdmin: true } } as any,
    organizationId: membership.organizationId,
  });
}

d("regenerateImage respects AI-off (no fabricated AI image)", () => {
  it("with referenceMimicry on + a real hero, regenerate must NOT produce an AI image", async () => {
    const caller = await superadminCaller();
    const res: any = await caller.repurpose.regenerateImage({
      headline: "Israel Did something",
      creativeStyle: "premium_editorial",
      theme: "dark",
      referenceMimicry: true,
      aestheticRefUrl: REF_URL,
      bgImageUrl: HERO_URL,
      headlineAlign: "right",
      channelName: "madaboutmarketingg",
      // NOTE: there is intentionally NO aiImages field today — that's the bug.
    } as any);
    console.log(`  [regen] bgSource=${res.bgSource} imageEngine=${res.imageEngine} mimicryEngine=${res.mimicryEngine} url=${res.url?.slice(0, 80)}`);
    // The user had AI OFF. Regenerate must be deterministic (layout-extract / real
    // photo) — NEVER an AI-generated background.
    expect(res.bgSource).toBe("real");
    expect(res.imageEngine).toBeNull();
    expect(res.mimicryEngine === null || res.mimicryEngine === "layout-extract").toBe(true);
  }, 180_000);
});
