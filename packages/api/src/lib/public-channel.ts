/**
 * The ONLY channel fields a procedure may hand to a client (security audit
 * 2026-09-28).
 *
 * packages/db decrypts accessToken / refreshToken on every direct channel read
 * or write, and `metadata` can carry `userAccessToken` (the Facebook USER token
 * behind every Instagram channel, which reaches every Page its consent granted).
 * `channel.toggleActive` once returned the full updated row, so any member of a
 * workspace could receive every platform's credentials in plaintext.
 *
 * Use both halves: the `select` stops the tokens being read (and so decrypted)
 * at all, and `toPublicChannel` is the in-code allowlist that makes a forgotten
 * `select` fail closed instead of leaking.
 */
export const PUBLIC_CHANNEL_SELECT = {
  id: true,
  organizationId: true,
  platform: true,
  platformId: true,
  name: true,
  username: true,
  avatar: true,
  isActive: true,
  tokenExpiresAt: true,
  disconnectedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PublicChannelKey = keyof typeof PUBLIC_CHANNEL_SELECT;
export type PublicChannel = { [K in PublicChannelKey]?: unknown };

export function toPublicChannel<T extends Record<string, unknown>>(row: T): Pick<T, Extract<keyof T, PublicChannelKey>> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(PUBLIC_CHANNEL_SELECT) as PublicChannelKey[]) {
    if (key in row) out[key] = row[key];
  }
  return out as Pick<T, Extract<keyof T, PublicChannelKey>>;
}
