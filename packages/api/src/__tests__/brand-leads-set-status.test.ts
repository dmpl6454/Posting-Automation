/**
 * Regression guard for the manual reply/outcome tracking fix (gap #3, 2026-06-22).
 *
 * Brand outreach has NO automated inbox integration — replies land in the
 * operator's own inbox and they log the outcome by hand via brandLeads.setStatus.
 * These tests lock the contract:
 *   - the mutation exists and is org-scoped (IDOR guard) + plan-gated;
 *   - it ONLY accepts the manual post-send outcomes (cannot shove a lead back to
 *     a pipeline state like APPROVED/SENT, which the workers own).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(
  join(__dirname, "..", "routers", "brand-leads.router.ts"),
  "utf8",
);
const setStatusProc = src.slice(src.indexOf("setStatus:"), src.length);

describe("brandLeads.setStatus (gap #3)", () => {
  it("the setStatus mutation exists", () => {
    expect(src).toMatch(/setStatus: adminOrgProcedure/); // RBAC 2026-07-17: brand-leads is admin-only
  });

  it("accepts ONLY the manual post-send outcomes (not pipeline states)", () => {
    expect(setStatusProc).toMatch(
      /z\.enum\(\["REPLIED", "INTERESTED", "NOT_INTERESTED", "CLOSED"\]\)/,
    );
    // Must NOT let the operator force pipeline states through this control.
    const enumDecl = setStatusProc.slice(0, setStatusProc.indexOf("}))"));
    expect(enumDecl).not.toMatch(/"APPROVED"|"SENT"|"PENDING"|"FAILED"/);
  });

  it("is org-scoped (IDOR guard via signal.organizationId)", () => {
    expect(setStatusProc).toMatch(
      /findFirstOrThrow\(\{\s*where: \{ id: input\.leadId, signal: \{ organizationId: ctx\.organizationId \} \}/,
    );
  });

  it("is plan-gated (PROFESSIONAL, with superadmin passthrough)", () => {
    expect(setStatusProc).toMatch(
      /requirePlan\(ctx\.organizationId, "PROFESSIONAL", "Brand Outreach", ctx\.isSuperAdmin\)/,
    );
  });

  it("list filter accepts the new statuses (so the UI can filter by them)", () => {
    for (const s of ["REPLIED", "INTERESTED", "NOT_INTERESTED", "CLOSED"]) {
      expect(src).toMatch(new RegExp(`"${s}"`));
    }
  });
});

describe("OutreachStatus schema has the manual outcome states (gap #3)", () => {
  const schema = readFileSync(
    join(__dirname, "..", "..", "..", "db", "prisma", "schema.prisma"),
    "utf8",
  );
  const enumBody = schema.slice(
    schema.indexOf("enum OutreachStatus"),
    schema.indexOf("}", schema.indexOf("enum OutreachStatus")),
  );

  for (const s of ["REPLIED", "INTERESTED", "NOT_INTERESTED", "CLOSED"]) {
    it(`OutreachStatus includes ${s}`, () => {
      expect(enumBody).toMatch(new RegExp(`\\b${s}\\b`));
    });
  }

  it("MessageStatus includes PENDING_MANUAL (gap #2, locked here too)", () => {
    const msgEnum = schema.slice(
      schema.indexOf("enum MessageStatus"),
      schema.indexOf("}", schema.indexOf("enum MessageStatus")),
    );
    expect(msgEnum).toMatch(/\bPENDING_MANUAL\b/);
  });
});
