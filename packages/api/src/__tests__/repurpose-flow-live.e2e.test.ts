/**
 * LIVE full-flow test of repurposeFromUrl through a real tRPC caller, as the
 * superadmin (tabish@dashmani.com, FREE org) — reproducing the reported bug
 * environment. Hits real DB + MinIO + AI + Puppeteer. Gated on LIVE_E2E=1.
 *
 * Verifies end-to-end:
 *   - static: captions + a branded headline creative actually upload (no more
 *     "captions but no image"); mediaFailed=false; mediaUrls populated.
 *   - ai_video gate: superadmin (FREE) is NOT blocked (the exact bug). We only
 *     assert the gate is passed — not full Veo3 (Google billing is on hold), so
 *     we expect it to proceed past the gate (and may fail later on the 403,
 *     which is acceptable — the point is the gate no longer throws FORBIDDEN).
 *
 * Run: LIVE_E2E=1 <env> pnpm exec vitest run packages/api/src/__tests__/repurpose-flow-live.e2e.test.ts
 */
import { describe, it, expect } from "vitest";
import { createCallerFactory } from "../trpc";
import { appRouter } from "../root";
import { prisma } from "@postautomation/db";

const LIVE = process.env.LIVE_E2E === "1" && !!process.env.OPENAI_API_KEY;
const d = LIVE ? describe : describe.skip;

const SUPERADMIN_EMAIL = "tabish@dashmani.com";
const TEST_URL = "https://indianexpress.com/";

const createCaller = createCallerFactory(appRouter);

async function superadminCaller() {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: SUPERADMIN_EMAIL } });
  const membership = await prisma.organizationMember.findFirstOrThrow({
    where: { userId: user.id },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  // Mirror what trpc.ts derives: orgProcedure reads session.user.id/.isSuperAdmin
  // and ctx.organizationId, then sets ctx.isSuperAdmin from the session.
  return createCaller({
    prisma,
    session: { user: { id: user.id, email: user.email, isSuperAdmin: true } } as any,
    organizationId: membership.organizationId,
  });
}

d("repurposeFromUrl full flow (LIVE, superadmin/FREE)", () => {
  it("static: produces captions AND an uploaded branded creative", async () => {
    const caller = await superadminCaller();
    const res = await caller.repurpose.repurposeFromUrl({
      url: TEST_URL,
      format: "static",
      targetPlatforms: ["INSTAGRAM", "TWITTER"],
      provider: "gemini",
      channelName: "Bollywood Chronicle",
      channelHandle: "bollywoodchronicle",
    });
    // Captions for both platforms
    expect(Object.keys(res.platformContent).length).toBeGreaterThan(0);
    // The fix: media actually produced (was empty before)
    expect(res.mediaFailed).toBe(false);
    expect(res.mediaUrls.length).toBeGreaterThan(0);
    expect(res.mediaUrls[0]).toMatch(/^https?:\/\//);
    // Same creative mapped to every requested platform
    expect(res.mediaMap?.INSTAGRAM?.url).toBeTruthy();
    console.log(`    [static] captions=${Object.keys(res.platformContent).length} media=${res.mediaUrls.length} url=${res.mediaUrls[0]}`);
  }, 180_000);

  it("ai_video gate: superadmin on FREE is NOT blocked by the plan gate", async () => {
    const caller = await superadminCaller();
    // The bug: this threw FORBIDDEN "upgrade to Professional" for a superadmin.
    // Now it must pass the gate. Veo3 itself may fail later (Google billing
    // hold) — that's fine; we assert it is NOT a FORBIDDEN plan error.
    try {
      const res = await caller.repurpose.repurposeFromUrl({
        url: TEST_URL,
        format: "ai_video",
        targetPlatforms: ["INSTAGRAM"],
        provider: "gemini",
      });
      // If it returns, the gate was passed (great).
      expect(res).toBeTruthy();
      console.log(`    [ai_video] gate passed, flow returned (mediaFailed=${res.mediaFailed})`);
    } catch (e: any) {
      // Acceptable: a downstream Veo3/billing failure. NOT acceptable: a
      // FORBIDDEN plan-gate block (the original bug).
      const code = e?.code || e?.cause?.code;
      const msg = String(e?.message || "");
      console.log(`    [ai_video] gate passed; downstream error (expected w/ billing hold): ${msg.slice(0, 120)}`);
      expect(code).not.toBe("FORBIDDEN");
      expect(msg).not.toMatch(/upgrade|Professional and Enterprise/i);
    }
  }, 180_000);
});
