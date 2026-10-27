/**
 * The publish worker used the refresh token read at JOB START. With rotating
 * refresh tokens (TikTok), a cron refresh in between spends that copy, the job's
 * refresh fails invalid_grant, and the worker tells the user to reconnect — which
 * for TikTok from India needs a VPN (2026-10-28).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refreshChannelToken, type TokenRow } from "../lib/channel-token-refresh";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const soon = new Date(NOW + 60_000);
const later = new Date(NOW + 24 * 3600_000);

function deps(rows: TokenRow[], opts: { written?: number; refreshed?: any } = {}) {
  let i = 0;
  const readRow = vi.fn(async () => rows[Math.min(i++, rows.length - 1)] ?? null);
  const writeIfUnchanged = vi.fn(async () => opts.written ?? 1);
  const refresh = vi.fn(async () => opts.refreshed ?? { accessToken: "act.new", refreshToken: "rft.new", expiresAt: later });
  return { readRow, writeIfUnchanged, refresh, now: () => NOW };
}

describe("refreshChannelToken", () => {
  it("reuses a token another refresher already produced — no refresh call at all", async () => {
    const d = deps([{ accessToken: "act.cron", refreshToken: "rft.cron", tokenExpiresAt: later }]);
    const r = await refreshChannelToken("act.old", d);
    expect(r).toEqual({ kind: "reused", accessToken: "act.cron", refreshToken: "rft.cron" });
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it("refreshes with the FRESH refresh token from the row, not the job's stale copy", async () => {
    const d = deps([{ accessToken: "act.old", refreshToken: "rft.rotated", tokenExpiresAt: soon }]);
    const r = await refreshChannelToken("act.old", d);
    expect(d.refresh).toHaveBeenCalledWith("rft.rotated");
    expect(d.writeIfUnchanged).toHaveBeenCalledWith(soon, { accessToken: "act.new", refreshToken: "rft.new", tokenExpiresAt: later });
    expect(r).toEqual({ kind: "refreshed", accessToken: "act.new", refreshToken: "rft.new" });
  });

  it("keeps the old refresh token when the platform does not rotate it", async () => {
    const d = deps([{ accessToken: "act.old", refreshToken: "rft.keep", tokenExpiresAt: soon }], {
      refreshed: { accessToken: "act.new", expiresAt: later },
    });
    expect((await refreshChannelToken("act.old", d)).refreshToken).toBe("rft.keep");
  });

  it("a token_expired retry with the SAME stored token still refreshes (the platform said it is dead)", async () => {
    const d = deps([{ accessToken: "act.same", refreshToken: "rft", tokenExpiresAt: later }]);
    await refreshChannelToken("act.same", d);
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it("losing the write race keeps the winner's stored refresh token", async () => {
    const d = deps(
      [
        { accessToken: "act.old", refreshToken: "rft.a", tokenExpiresAt: soon },
        { accessToken: "act.winner", refreshToken: "rft.winner", tokenExpiresAt: later },
      ],
      { written: 0 },
    );
    const r = await refreshChannelToken("act.old", d);
    expect(r).toEqual({ kind: "lost_race", accessToken: "act.new", refreshToken: "rft.winner" });
  });

  it("propagates the provider's error (the worker's invalid_grant handling stays the same)", async () => {
    const d = deps([{ accessToken: "act.old", refreshToken: "rft", tokenExpiresAt: soon }]);
    d.refresh.mockRejectedValueOnce(new Error("TikTok token refresh failed (invalid_grant)."));
    await expect(refreshChannelToken("act.old", d)).rejects.toThrow(/invalid_grant/);
  });
});

describe("post-publish wiring", () => {
  it("both refresh sites go through refreshChannelToken, never channel.refreshToken directly", () => {
    const src = readFileSync(join(__dirname, "../workers/post-publish.worker.ts"), "utf8");
    expect(src.match(/refreshChannelToken\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/provider\.refreshAccessToken\(\s*channel\.refreshToken/);
  });
});
