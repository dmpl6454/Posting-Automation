/**
 * Which of a post's open publish gates (pendingPublishGates, from
 * @postautomation/queue publish-gates) should block a MANUAL publish —
 * post.publishNow (Retry) and bulk.bulkSchedule.
 *
 * The caption fan-out gates describe the parked DRAFT the worker is about to
 * flip. The worker only clears its flag while the post is still DRAFT, so a
 * post that became FAILED/CANCELLED/... can carry a stale pendingSchedule/held
 * forever; honouring it there made Retry refuse permanently with a false "will
 * publish automatically". The super-text gate stays unconditional: publishing
 * mid-burn would post the un-burned video.
 */
const DRAFT_ONLY_GATES = new Set(["captionFanout", "captionFanoutHeld"]);

export function gatesBlockingManualPublish(postStatus: string | null | undefined, openGates: string[]): string[] {
  if (postStatus === "DRAFT") return openGates;
  return openGates.filter((g) => !DRAFT_ONLY_GATES.has(g));
}
