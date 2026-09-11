import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { signState, verifyState } from "../utils/oauth-helper";

const APP_B = "259982148841906";

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.OAUTH_STATE_SECRET;
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-at-least-16-chars";
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.OAUTH_STATE_SECRET;
  else process.env.OAUTH_STATE_SECRET = savedSecret;
});

describe("OAuth state carries the Meta app", () => {
  // The app that built the authorize URL MUST be the app the callback exchanges
  // the code against. Re-deriving it in the callback (from the org row or an
  // env default) exchanges against the wrong app whenever anything changed in
  // the up-to-10-minute gap — and Meta burns the single-use code on the way.
  it("round-trips metaAppId through sign → verify", () => {
    const token = signState({ organizationId: "org1", userId: "u1", metaAppId: APP_B });
    expect(verifyState(token).metaAppId).toBe(APP_B);
  });

  it("keeps the app id inside the SIGNED payload, so it cannot be swapped", () => {
    const token = signState({ organizationId: "org1", userId: "u1", metaAppId: APP_B });
    const [body, sig] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, "base64url").toString("utf8")),
        metaAppId: "999999",
      })
    ).toString("base64url");

    expect(() => verifyState(`${tampered}.${sig}`)).toThrow(/signature/i);
  });

  // 🔴 Deploy safety: states signed by the PREVIOUS build stay in flight for
  // the whole 10-minute TTL. They arrive with no metaAppId, and absent MUST
  // mean the legacy app — which is what those flows actually used.
  it("verifies a state signed WITHOUT metaAppId (pre-deploy, still in flight)", () => {
    const token = signState({ organizationId: "org1", userId: "u1" });
    const payload = verifyState(token);
    expect(payload.metaAppId).toBeUndefined();
    expect(payload.organizationId).toBe("org1");
  });

  it("verifies a state whose signed body literally lacks the key", () => {
    // Hand-build the pre-change payload shape to prove forward-compat, rather
    // than relying on signState happening to omit an undefined field.
    const key = crypto
      .createHash("sha256")
      .update(process.env.OAUTH_STATE_SECRET!)
      .digest();
    const now = Date.now();
    const body = Buffer.from(
      JSON.stringify({
        organizationId: "org1",
        userId: "u1",
        nonce: "abc",
        iat: now,
        exp: now + 60_000,
      })
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", key).update(body).digest("base64url");

    const payload = verifyState(`${body}.${sig}`);
    expect(payload.metaAppId).toBeUndefined();
    expect(payload.userId).toBe("u1");
  });

  it("leaves codeVerifier (PKCE) working alongside the new field", () => {
    const token = signState({
      organizationId: "org1",
      userId: "u1",
      codeVerifier: "verifier-123",
      metaAppId: APP_B,
    });
    const payload = verifyState(token);
    expect(payload.codeVerifier).toBe("verifier-123");
    expect(payload.metaAppId).toBe(APP_B);
  });

  it("still rejects an expired state carrying an app id", () => {
    const key = crypto
      .createHash("sha256")
      .update(process.env.OAUTH_STATE_SECRET!)
      .digest();
    const body = Buffer.from(
      JSON.stringify({
        organizationId: "org1",
        userId: "u1",
        metaAppId: APP_B,
        nonce: "abc",
        iat: Date.now() - 60_000,
        exp: Date.now() - 1_000,
      })
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", key).update(body).digest("base64url");
    expect(() => verifyState(`${body}.${sig}`)).toThrow(/expired/i);
  });
});
