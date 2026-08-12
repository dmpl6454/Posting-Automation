import { describe, it, expect } from "vitest";
import {
  deriveInsightsHealth,
  healthVerdictChanged,
  mergeInsightsHealth,
} from "../lib/channel-insights-health";

const NOW = new Date("2026-08-06T12:00:00.000Z");

describe("deriveInsightsHealth", () => {
  it("reports ok when the capture was not degraded", () => {
    expect(deriveInsightsHealth(undefined, NOW)).toEqual({
      status: "ok",
      checkedAt: NOW.toISOString(),
    });
  });

  it("maps a missing scope to needs_reconnect, keeping the named scopes", () => {
    const h = deriveInsightsHealth(
      { reason: "missing_scope", missingScopes: ["read_insights"], detail: "Reconnect to grant: read_insights." },
      NOW
    );
    expect(h.status).toBe("needs_reconnect");
    expect(h.reason).toBe("missing_scope");
    expect(h.missingScopes).toEqual(["read_insights"]);
  });

  it("maps a dead token to needs_reconnect — the same user action fixes it", () => {
    expect(deriveInsightsHealth({ reason: "token_invalid" }, NOW).status).toBe("needs_reconnect");
  });

  it("maps page_access_lost to needs_reconnect and preserves the reason", () => {
    // Every actionable reason MUST be listed in deriveInsightsHealth. An
    // unlisted one falls through to "ok", which marks a channel that reports
    // nothing as healthy — silent data loss with no explanation anywhere.
    const h = deriveInsightsHealth(
      { reason: "page_access_lost", detail: "not ticked in the permission screen" },
      NOW
    );
    expect(h.status).toBe("needs_reconnect");
    expect(h.reason).toBe("page_access_lost");
  });

  it("does NOT nag for a non-actionable reason", () => {
    // "no_data" isn't something reconnecting fixes; surfacing it would train
    // users to ignore the banner.
    expect(deriveInsightsHealth({ reason: "no_data" }, NOW).status).toBe("ok");
    expect(deriveInsightsHealth({ reason: "something_new" }, NOW).status).toBe("ok");
  });
});

describe("healthVerdictChanged", () => {
  const base = { status: "needs_reconnect" as const, reason: "missing_scope", missingScopes: ["read_insights"], checkedAt: "x" };

  it("is false when only checkedAt moved — otherwise EVERY sync would write", () => {
    expect(healthVerdictChanged({ ...base, checkedAt: "older" }, { ...base, checkedAt: "newer" })).toBe(false);
  });

  it("is true when the status flips", () => {
    expect(healthVerdictChanged({ ...base }, { status: "ok", checkedAt: "y" })).toBe(true);
  });

  it("is true when the missing-scope set changes", () => {
    expect(
      healthVerdictChanged({ ...base }, { ...base, missingScopes: ["read_insights", "pages_read_user_content"] })
    ).toBe(true);
  });

  it("ignores scope ORDER — the same set is the same verdict", () => {
    expect(
      healthVerdictChanged(
        { ...base, missingScopes: ["a_b", "c_d"] },
        { ...base, missingScopes: ["c_d", "a_b"] }
      )
    ).toBe(false);
  });

  it("is true when there is no prior verdict at all", () => {
    expect(healthVerdictChanged(undefined, { status: "ok", checkedAt: "y" })).toBe(true);
    expect(healthVerdictChanged("garbage", { status: "ok", checkedAt: "y" })).toBe(true);
  });
});

describe("mergeInsightsHealth", () => {
  it("PRESERVES unrelated metadata keys", () => {
    // igUserId / orgId / instance / service live here — losing any of them would
    // break posting or send a bearer token to the wrong host.
    const merged = mergeInsightsHealth(
      { igUserId: "17841427778726243", instance: "https://mastodon.social" },
      { status: "needs_reconnect", checkedAt: NOW.toISOString() }
    );
    expect(merged).toMatchObject({
      igUserId: "17841427778726243",
      instance: "https://mastodon.social",
    });
    expect((merged as any).insightsHealth.status).toBe("needs_reconnect");
  });

  it("returns null when the verdict is unchanged, so no UPDATE is issued", () => {
    const existing = {
      igUserId: "1",
      insightsHealth: { status: "ok", checkedAt: "2026-08-01T00:00:00.000Z" },
    };
    expect(mergeInsightsHealth(existing, { status: "ok", checkedAt: NOW.toISOString() })).toBeNull();
  });

  it("handles a null / non-object metadata column", () => {
    const merged = mergeInsightsHealth(null, { status: "ok", checkedAt: NOW.toISOString() });
    expect((merged as any).insightsHealth.status).toBe("ok");
    const fromArray = mergeInsightsHealth([1, 2], { status: "ok", checkedAt: NOW.toISOString() });
    expect((fromArray as any).insightsHealth.status).toBe("ok");
  });
});
