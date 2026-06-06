/**
 * LIVE test of the Seedance (fal.ai) poll-URL fix. The bug: status was polled
 * at the full model path → HTTP 405 forever → 7.5min "perpetual generating".
 * Fix: use the canonical status_url/response_url from the submit response.
 *
 * Gated on LIVE_E2E=1 + FAL_KEY. Real fal.ai generation (~30s-3min, costs).
 * Run: LIVE_E2E=1 FAL_KEY=... pnpm exec vitest run packages/ai/src/__tests__/seedance-live.e2e.test.ts
 */
import { describe, it, expect } from "vitest";
import { generateSeedanceVideo } from "../providers/seedance.provider";

const LIVE = process.env.LIVE_E2E === "1" && !!process.env.FAL_KEY;
const d = LIVE ? describe : describe.skip;

d("Seedance video (LIVE, fal.ai)", () => {
  it("completes — polls the correct status_url, no 405/timeout", async () => {
    const progressTicks: number[] = [];
    const res = await generateSeedanceVideo({
      prompt: "A calm sunrise over mountains, cinematic, slow camera pan",
      duration: 5,
      aspectRatio: "9:16",
      resolution: "720p",
      onProgress: ({ elapsedSeconds }) => progressTicks.push(elapsedSeconds),
    });
    expect(res.videoBase64.length).toBeGreaterThan(1000);
    expect(res.mimeType).toContain("video");
    // Progress callback fired during polling (proves the loop actually ran and
    // saw non-405 status responses).
    expect(progressTicks.length).toBeGreaterThan(0);
    console.log(`    [seedance] video bytes=${res.videoBase64.length}, duration=${res.durationSeconds}s, progress ticks=${progressTicks.length}`);
  }, 480_000);
});
