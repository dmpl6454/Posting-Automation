/**
 * The publish worker used the refresh token read at JOB START. With rotating
 * refresh tokens (TikTok), a cron refresh in between spends that copy, the job's
 * refresh fails invalid_grant, and the worker tells the user to reconnect — which
 * for TikTok from India needs a VPN (2026-10-28).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refreshChannelToken, prismaChannelTokenRefreshDeps, type TokenRow } from "../lib/channel-token-refresh";

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

  it("a refresh that fails because ANOTHER refresher spent the rotated token reuses the winner's token", async () => {
    // Between our read and our refresh, the cron (or Compose's creator_info)
    // refreshed with the same refresh token. TikTok rotated it, so ours fails
    // invalid_grant — which the worker reads as "reconnect" (a VPN trip from
    // India) on a perfectly healthy channel.
    const d = deps([
      { accessToken: "act.old", refreshToken: "rft.1", tokenExpiresAt: soon },
      { accessToken: "act.cron", refreshToken: "rft.2", tokenExpiresAt: later },
    ]);
    d.refresh.mockRejectedValueOnce(new Error("TikTok token refresh failed (invalid_grant)."));
    expect(await refreshChannelToken("act.old", d)).toEqual({ kind: "reused", accessToken: "act.cron", refreshToken: "rft.2" });
    expect(d.writeIfUnchanged).not.toHaveBeenCalled();
  });

  it("a failed refresh with no newer token in the row still throws the provider's error", async () => {
    const d = deps([{ accessToken: "act.old", refreshToken: "rft", tokenExpiresAt: soon }]);
    d.refresh.mockRejectedValueOnce(new Error("TikTok token refresh failed (invalid_grant)."));
    await expect(refreshChannelToken("act.old", d)).rejects.toThrow(/invalid_grant/);
    expect(d.readRow).toHaveBeenCalledTimes(2);
  });
});

describe("prismaChannelTokenRefreshDeps", () => {
  function fakeDb(row: TokenRow | null) {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async () => row);
    return { db: { channel: { findUnique, updateMany } }, updateMany, findUnique };
  }

  it("persists only while the row is unchanged AND still connected", async () => {
    // A disconnect writes a placeholder token and clears the refresh token but
    // leaves tokenExpiresAt alone; without disconnectedAt in the WHERE an
    // in-flight refresh wrote live tokens back onto the disconnected channel.
    const f = fakeDb({ accessToken: "a", refreshToken: "r", tokenExpiresAt: soon });
    const d = prismaChannelTokenRefreshDeps(f.db, "ch1", async () => ({ accessToken: "x" }));
    await d.writeIfUnchanged(soon, { accessToken: "x", refreshToken: "r", tokenExpiresAt: later });
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { id: "ch1", tokenExpiresAt: soon, disconnectedAt: null },
      data: { accessToken: "x", refreshToken: "r", tokenExpiresAt: later },
    });
  });

  it("reads the token columns directly (a direct channel read is what decrypts them)", async () => {
    const f = fakeDb({ accessToken: "a", refreshToken: "r", tokenExpiresAt: soon });
    const d = prismaChannelTokenRefreshDeps(f.db, "ch1", async () => ({ accessToken: "x" }));
    expect(await d.readRow()).toEqual({ accessToken: "a", refreshToken: "r", tokenExpiresAt: soon });
    expect(f.findUnique).toHaveBeenCalledWith({
      where: { id: "ch1" },
      select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
    });
  });
});

describe("wiring", () => {
  it("both publish refresh sites go through refreshChannelToken, never channel.refreshToken directly", () => {
    const src = readFileSync(join(__dirname, "../workers/post-publish.worker.ts"), "utf8");
    expect(src.match(/refreshChannelToken\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/provider\.refreshAccessToken\(\s*channel\.refreshToken/);
  });

  it("the 30-minute cron refresh uses the same race-safe helper (it used to write unconditionally)", () => {
    const src = readFileSync(join(__dirname, "../workers/token-refresh.worker.ts"), "utf8");
    expect(src).toMatch(/refreshChannelToken\(/);
    expect(src).toMatch(/prismaChannelTokenRefreshDeps\(/);
    expect(src).not.toMatch(/prisma\.channel\.update\(/);
  });
});
