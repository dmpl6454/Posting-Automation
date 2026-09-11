import crypto from "crypto";
import { listMetaWebhookSecrets } from "./meta-app-registry";

/**
 * Verifies Meta's `X-Hub-Signature-256` header against every Meta app this
 * deployment is configured for.
 *
 * ── Why this is shared rather than inlined in each route ─────────────────────
 * `apps/web/app/api/webhooks/facebook/route.ts` and `.../instagram/route.ts`
 * each had their own copy of the comparison. Both copies carried the same bug
 * (below). One implementation, imported twice, is what keeps the rules from
 * drifting apart again.
 *
 * ── 🔴 The bug this replaces (live on prod, reproduced) ──────────────────────
 * The old guard was:
 *
 *     if (signature.length !== expected.length ||
 *         !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
 *
 * `signature.length` is a JS STRING length (UTF-16 code units); `timingSafeEqual`
 * compares BYTE length. A 71-character header containing one 2-byte UTF-8
 * character passes the guard at 72 bytes and makes `timingSafeEqual` THROW
 * `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`. The throw escapes the route, so ANY
 * anonymous caller could return a 500 from an endpoint that nginx deliberately
 * exempts from rate limiting (docker/nginx/nginx.conf — "verifying HMAC makes
 * unauthenticated abuse a cheap 401").
 *
 * The fix is structural, not a patched guard: parse the header with a strict
 * regex and decode it to a FIXED 32-byte buffer. Both sides of every comparison
 * are then always 32 bytes, so the throw is unreachable by construction.
 *
 * ── Multi-app rules ──────────────────────────────────────────────────────────
 * - Empty secrets can never be candidates: `listMetaWebhookSecrets` drops them,
 *   because `createHmac("sha256", "")` produces a valid, attacker-computable
 *   digest — an empty secret is an auth BYPASS, not a disabled feature.
 * - The shape check runs BEFORE any HMAC, so garbage costs one regex, not N
 *   hashes.
 * - The loop does not short-circuit on the first match, so acceptance time does
 *   not reveal WHICH app signed.
 * - The matched `appId` is RETURNED so the caller can scope what the event is
 *   allowed to touch. Accepting either app's signature must not let a holder of
 *   app B's secret forge events about app A's pages.
 */

/** `sha256=` followed by exactly 64 lowercase hex characters. */
const SIGNATURE_RE = /^sha256=([a-f0-9]{64})$/;

export type MetaWebhookVerification =
  | { ok: true; appId: string }
  | { ok: false; reason: "not_configured" | "malformed" | "mismatch" };

export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  candidates: Array<{ appId: string; secret: string }> = listMetaWebhookSecrets()
): MetaWebhookVerification {
  // Fail closed when nothing is configured. The old routes had an explicit
  // `if (!APP_SECRET) return 500`; a candidate LIST loses that guard unless it
  // is restated here, because ["", ...] is a non-empty array.
  if (candidates.length === 0) return { ok: false, reason: "not_configured" };

  const match = typeof signatureHeader === "string" ? SIGNATURE_RE.exec(signatureHeader) : null;
  if (!match) return { ok: false, reason: "malformed" };

  // Exactly 32 bytes, guaranteed by the regex — this is what makes
  // timingSafeEqual's length throw unreachable.
  const provided = Buffer.from(match[1]!, "hex");

  let matchedAppId: string | null = null;
  for (const { appId, secret } of candidates) {
    if (!secret) continue; // defence in depth; the registry already filters
    const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
    // Both operands are 32 bytes. No length branch, no throw.
    if (crypto.timingSafeEqual(provided, expected) && matchedAppId === null) {
      matchedAppId = appId;
    }
  }

  return matchedAppId ? { ok: true, appId: matchedAppId } : { ok: false, reason: "mismatch" };
}
