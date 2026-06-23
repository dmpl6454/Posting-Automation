/**
 * Regression guard for the outreach-send honest-status fix (gap #2, 2026-06-22).
 *
 * Bug: LinkedIn/Instagram DM have no programmatic send API — the stubs only
 * logged to console and returned, so the worker marked the message SENT, falsely
 * claiming a DM was delivered. And a lead with only such messages flipped to
 * SENT while nothing was sent.
 *
 * Fix: send fns return a SendOutcome ("sent" | "pending_manual"); the worker maps
 *   error            → FAILED   (sentAt null)
 *   "pending_manual" → PENDING_MANUAL (sentAt null — NOT a delivery)
 *   "sent"           → SENT     (sentAt set)
 * and the lead-completion check treats PENDING_MANUAL as not-done.
 *
 * These tests lock the pure mapping logic (mirrored from the worker) so a future
 * edit can't quietly route a non-send back to SENT.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

type SendOutcome = "sent" | "pending_manual";

// Mirror of the worker's status mapping (apps/worker/src/workers/outreach-send.worker.ts)
function mapStatus(error: string | null, outcome: SendOutcome | null) {
  return error ? "FAILED" : outcome === "pending_manual" ? "PENDING_MANUAL" : "SENT";
}
function sentAtFor(status: string): Date | null {
  return status === "SENT" ? new Date() : null;
}

describe("outreach-send status mapping (gap #2)", () => {
  it("a real send ('sent') → SENT with sentAt", () => {
    const s = mapStatus(null, "sent");
    expect(s).toBe("SENT");
    expect(sentAtFor(s)).toBeInstanceOf(Date);
  });

  it("a stubbed channel ('pending_manual') → PENDING_MANUAL, NOT SENT, no sentAt", () => {
    const s = mapStatus(null, "pending_manual");
    expect(s).toBe("PENDING_MANUAL");
    expect(s).not.toBe("SENT");
    expect(sentAtFor(s)).toBeNull();
  });

  it("a thrown error → FAILED, no sentAt", () => {
    const s = mapStatus("Resend API error 500", "sent");
    expect(s).toBe("FAILED");
    expect(sentAtFor(s)).toBeNull();
  });

  it("lead-completion 'pending' set includes PENDING_MANUAL (a manual-only lead is NOT done)", () => {
    // The worker counts these statuses as keeping the lead out of SENT.
    const PENDING_SET = ["DRAFT", "QUEUED", "PENDING_MANUAL"];
    expect(PENDING_SET).toContain("PENDING_MANUAL");
    // A lead whose only message is PENDING_MANUAL has pendingMsgs > 0 → not SENT.
    const leadMessages = [{ status: "PENDING_MANUAL" }];
    const pending = leadMessages.filter((m) => PENDING_SET.includes(m.status)).length;
    expect(pending).toBeGreaterThan(0);
  });
});

describe("outreach-send worker source wiring (gap #2)", () => {
  const src = readFileSync(
    join(__dirname, "..", "outreach-send.worker.ts"),
    "utf8",
  );

  it("LinkedIn DM returns pending_manual (no longer falls through to SENT)", () => {
    const fn = src.slice(src.indexOf("function sendLinkedInDM"), src.indexOf("function sendTwitterDM"));
    expect(fn).toMatch(/return "pending_manual"/);
    expect(fn).not.toMatch(/return "sent"/);
  });

  it("Instagram DM returns pending_manual", () => {
    const fn = src.slice(src.indexOf("function sendInstagramDM"), src.indexOf("export function createOutreachSendWorker"));
    expect(fn).toMatch(/return "pending_manual"/);
  });

  it("status update can resolve to PENDING_MANUAL", () => {
    expect(src).toMatch(/PENDING_MANUAL/);
  });

  it("sentAt is set ONLY for a real SENT (never PENDING_MANUAL/FAILED)", () => {
    expect(src).toMatch(/sentAt: newStatus === "SENT" \? new Date\(\) : null/);
  });

  it("lead-completion count treats PENDING_MANUAL as still-pending", () => {
    expect(src).toMatch(/status: \{ in: \["DRAFT", "QUEUED", "PENDING_MANUAL"\] \}/);
  });
});
