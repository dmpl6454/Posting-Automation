import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Channel Groups cards are COLLAPSED by default (owner ask 2026-10-04): the
 * 493-row channel picker renders only for a group whose header was clicked.
 * Asserted at the source level, house pattern (see story-ui-contract.test.ts).
 */
const ROOT = join(__dirname, "..", "..", "..");
const page = readFileSync(join(ROOT, "apps/web/app/dashboard/channels/page.tsx"), "utf8");

describe("Channel Groups — collapsed by default", () => {
  it("starts with NO group expanded and toggles per group id", () => {
    expect(page).toContain("const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());");
    expect(page).toMatch(/const toggleGroupExpanded = \(groupId: string\) =>\s*setExpandedGroupIds\(/);
  });

  it("the picker is RENDERED only for an expanded group (not merely hidden)", () => {
    // The whole panel — platform pills, Select all/Remove all and the checkbox
    // grid — sits behind the expanded check; the grid itself is inside it.
    const panel = page.indexOf("{expandedGroupIds.has(group.id) && (");
    const grid = page.indexOf('<div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">');
    const batchButtons = page.indexOf("Select all{missing.length > 0");
    expect(panel).toBeGreaterThan(0);
    expect(batchButtons).toBeGreaterThan(panel);
    expect(grid).toBeGreaterThan(panel);
    expect(page).toContain('data-testid="channel-group-panel"');
  });

  it("the header is the accessible toggle; edit and delete never flip it", () => {
    expect(page).toContain('data-testid="channel-group-toggle"');
    expect(page).toContain("aria-expanded={expandedGroupIds.has(group.id)}");
    expect(page).toContain("onClick={() => toggleGroupExpanded(group.id)}");
    expect(page.match(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); (setEditingGroupId|if \(confirm\("Delete this group\?"\)\))/g)).toHaveLength(2);
  });

  it("a just-created group opens itself so the 'add channels below' toast is true", () => {
    expect(page).toMatch(/setHighlightedGroupId\(group\.id\);\s*setExpandedGroupIds\(\(prev\) => new Set\(prev\)\.add\(group\.id\)\);/);
  });
});
