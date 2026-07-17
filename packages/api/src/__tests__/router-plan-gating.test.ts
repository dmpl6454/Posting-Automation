/**
 * Regression guard for the plan-gating WIRING fixes (gaps #1 + #4, 2026-06-22).
 *
 * The middleware itself (requirePlan) is already covered by billing-disabled.test
 * and chat-action-gating.test. What those CAN'T catch is a procedure that simply
 * forgot to CALL the gate — which is exactly the bug we fixed:
 *   #1 agent.create / agent.update had no requirePlan (only agent.list did).
 *   #4 campaign.* — only list() gated; byId/listBrands/brandContent/listInfluencers
 *      + all create/update/delete siblings were ungated (M23).
 *
 * These tests read the router SOURCE and assert every data-touching procedure is
 * gated, so a future edit that adds an ungated sibling fails loudly. Source-level
 * (not caller-level) because the bug is structural: "is the gate present at all".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROUTERS = join(__dirname, "..", "routers");
const agentSrc = readFileSync(join(ROUTERS, "agent.router.ts"), "utf8");
const campaignSrc = readFileSync(join(ROUTERS, "campaign.router.ts"), "utf8");

/** Extract each `name: orgProcedure ... ` procedure body up to the next top-level procedure. */
function procedureBodies(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Match "  name: orgProcedure" at 2-space indent (router member).
  const re = /^ {2}(\w+): (?:adminOrgProcedure|orgProcedure)/gm; // RBAC 2026-07-17: campaign router is admin-gated; plan gate assertions unchanged
  const starts: Array<{ name: string; idx: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) starts.push({ name: m[1]!, idx: m.index });
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.idx;
    const to = i + 1 < starts.length ? starts[i + 1]!.idx : src.length;
    out[starts[i]!.name] = src.slice(from, to);
  }
  return out;
}

describe("agent.router plan gating (gap #1)", () => {
  const procs = procedureBodies(agentSrc);

  it("agent.create calls requirePlan(STARTER)", () => {
    expect(procs.create).toMatch(/requirePlan\([^)]*"STARTER"/);
  });

  it("agent.update calls requirePlan(STARTER)", () => {
    expect(procs.update).toMatch(/requirePlan\([^)]*"STARTER"/);
  });

  it("agent.list still gates STARTER (unchanged)", () => {
    expect(procs.list).toMatch(/requirePlan\([^)]*"STARTER"/);
  });

  it("gates pass through ctx.isSuperAdmin (superadmin exemption preserved)", () => {
    expect(procs.create).toMatch(/requirePlan\([^)]*ctx\.isSuperAdmin\)/);
    expect(procs.update).toMatch(/requirePlan\([^)]*ctx\.isSuperAdmin\)/);
  });
});

describe("campaign.router plan gating (gap #4 / M23)", () => {
  const procs = procedureBodies(campaignSrc);

  // Every data-touching procedure must be gated — list was the only one before.
  const GATED = [
    "list", "byId", "create", "update", "delete",
    "listBrands", "createBrand", "updateBrand", "deleteBrand",
    "brandContent", "listInfluencers", "createInfluencer",
    "updateInfluencer", "deleteInfluencer", "influencerStats",
  ];

  for (const name of GATED) {
    it(`campaign.${name} is gated (gateCampaigns)`, () => {
      expect(procs[name], `procedure ${name} not found in source`).toBeTruthy();
      expect(procs[name]).toMatch(/await gateCampaigns\(ctx\)/);
    });
  }

  it("gateCampaigns enforces PROFESSIONAL with ctx.isSuperAdmin passthrough", () => {
    expect(campaignSrc).toMatch(
      /function gateCampaigns[\s\S]*requirePlan\([^)]*"PROFESSIONAL"[^)]*ctx\.isSuperAdmin\)/
    );
  });

  it("every orgProcedure in the campaign router is gated (no ungated sibling slips in)", () => {
    for (const [name, body] of Object.entries(procs)) {
      expect(body, `campaign.${name} is an orgProcedure but has no gateCampaigns call`).toMatch(
        /await gateCampaigns\(ctx\)/
      );
    }
  });
});
