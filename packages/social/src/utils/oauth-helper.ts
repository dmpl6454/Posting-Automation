import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────
// State signing (CSRF protection for OAuth flow)
// ─────────────────────────────────────────────────────────────────────
//
// The OAuth `state` parameter MUST be unforgeable. Previously this
// codebase used `${randomHex}:${orgId}` plaintext, which an attacker
// could craft to bind their connected account to any org.
//
// signState(payload) returns a compact base64url HMAC-signed token
// that includes a nonce, the org/user binding, an issue time and exp.
// verifyState(token) checks signature, expiry, and returns the payload.

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getSigningKey(): Buffer {
  const k = process.env.OAUTH_STATE_SECRET || process.env.NEXTAUTH_SECRET;
  if (!k || k.length < 16) {
    throw new Error(
      "OAUTH_STATE_SECRET (or NEXTAUTH_SECRET) must be set to a strong value (>=16 chars) for OAuth state signing"
    );
  }
  return crypto.createHash("sha256").update(k).digest();
}

export interface OAuthStatePayload {
  organizationId: string;
  userId: string;
  codeVerifier?: string; // PKCE — kept server-side, not in URL
  nonce: string;
  iat: number;
  exp: number;
}

export function signState(input: {
  organizationId: string;
  userId: string;
  codeVerifier?: string;
}): string {
  const key = getSigningKey();
  const now = Date.now();
  const payload: OAuthStatePayload = {
    organizationId: input.organizationId,
    userId: input.userId,
    codeVerifier: input.codeVerifier,
    nonce: crypto.randomBytes(16).toString("hex"),
    iat: now,
    exp: now + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(token: string): OAuthStatePayload {
  if (!token || typeof token !== "string") throw new Error("Invalid state");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid state format");
  const [body, sig] = parts as [string, string];

  const key = getSigningKey();
  const expected = crypto.createHmac("sha256", key).update(body).digest("base64url");

  // Timing-safe comparison
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid state signature");
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid state body");
  }
  if (!payload.organizationId || !payload.userId || !payload.exp) {
    throw new Error("Invalid state payload");
  }
  if (Date.now() > payload.exp) {
    throw new Error("State expired");
  }
  return payload;
}

// Backward-compat helper — kept so callers that need a raw nonce still work.
export function generateState(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = crypto.createHash("sha256").update(verifier).digest();
  return digest.toString("base64url");
}

// Token encryption helpers live in @postautomation/db (so the Prisma
// client extension can use them without a circular dependency). Re-export
// here so existing callers can keep importing from @postautomation/social.
export { encryptToken, decryptToken, isEncrypted } from "@postautomation/db";
