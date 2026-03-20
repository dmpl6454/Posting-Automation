/**
 * Temporary in-memory store for OAuth 1.0a request token secrets.
 * The secret is stored when we get a request token, then retrieved and deleted
 * in the callback when we exchange for the access token.
 * Entries expire after 10 minutes — plenty of time for the OAuth redirect flow.
 */

interface TempEntry {
  secret: string;
  expiresAt: number;
}

const store = new Map<string, TempEntry>();

export function storeRequestTokenSecret(requestToken: string, secret: string): void {
  // Clean up expired entries while we're here
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt < now) store.delete(key);
  }
  store.set(requestToken, { secret, expiresAt: now + 10 * 60 * 1000 });
}

export function getAndDeleteRequestTokenSecret(requestToken: string): string | undefined {
  const entry = store.get(requestToken);
  if (!entry) return undefined;
  store.delete(requestToken);
  if (entry.expiresAt < Date.now()) return undefined;
  return entry.secret;
}
