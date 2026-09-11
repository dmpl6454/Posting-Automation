import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import {
  resolveMetaCredentials,
  legacyMetaCredentials,
  listExtraMetaApps,
  listMetaWebhookSecrets,
  hasMultipleMetaApps,
  isKnownMetaAppId,
} from "../utils/meta-app-registry";
import { verifyMetaWebhookSignature } from "../utils/meta-webhook-signature";

const META_KEYS = [
  "FACEBOOK_CLIENT_ID",
  "FACEBOOK_CLIENT_SECRET",
  "INSTAGRAM_CLIENT_ID",
  "INSTAGRAM_CLIENT_SECRET",
  "META_APP_2_ID",
  "META_APP_2_SECRET",
  "META_APP_3_ID",
  "META_APP_3_SECRET",
];

const APP_A = "298449321694397";
const APP_B = "259982148841906";

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of META_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of META_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function configureLegacy() {
  process.env.FACEBOOK_CLIENT_ID = APP_A;
  process.env.FACEBOOK_CLIENT_SECRET = "secret-a";
  process.env.INSTAGRAM_CLIENT_ID = APP_A;
  process.env.INSTAGRAM_CLIENT_SECRET = "secret-a";
}

describe("meta-app-registry — legacy path (NULL metaAppId)", () => {
  it("resolves a NULL metaAppId to the platform's own legacy pair", () => {
    configureLegacy();
    expect(resolveMetaCredentials("FACEBOOK", null)).toEqual({
      appId: APP_A,
      clientId: APP_A,
      clientSecret: "secret-a",
      legacy: true,
    });
    expect(resolveMetaCredentials("INSTAGRAM", undefined)?.legacy).toBe(true);
  });

  // RULE 2. FACEBOOK_* and INSTAGRAM_* are four distinct env keys. Collapsing
  // them into one "app A" entry silently repoints Instagram the day they differ.
  it("keeps FACEBOOK and INSTAGRAM as INDEPENDENT credential pairs", () => {
    process.env.FACEBOOK_CLIENT_ID = "fb-app";
    process.env.FACEBOOK_CLIENT_SECRET = "fb-secret";
    process.env.INSTAGRAM_CLIENT_ID = "ig-app";
    process.env.INSTAGRAM_CLIENT_SECRET = "ig-secret";

    expect(resolveMetaCredentials("FACEBOOK", null)?.clientSecret).toBe("fb-secret");
    expect(resolveMetaCredentials("INSTAGRAM", null)?.clientSecret).toBe("ig-secret");
  });

  it("an explicit id equal to the legacy app resolves to the legacy pair", () => {
    configureLegacy();
    const byNull = resolveMetaCredentials("FACEBOOK", null);
    const byId = resolveMetaCredentials("FACEBOOK", APP_A);
    expect(byId).toEqual(byNull);
    expect(byId?.legacy).toBe(true);
  });

  it("returns null (never throws) when the legacy pair is unset", () => {
    expect(() => resolveMetaCredentials("FACEBOOK", null)).not.toThrow();
    expect(resolveMetaCredentials("FACEBOOK", null)).toBeNull();
  });
});

describe("meta-app-registry — fail-closed on the compose allowlist trap", () => {
  // A key in .env.prod but absent from docker-compose.prod.yml's explicit
  // `environment:` map arrives as "" — not undefined.
  it('treats "" exactly like missing for BOTH halves of a pair', () => {
    configureLegacy();
    process.env.META_APP_2_ID = "";
    process.env.META_APP_2_SECRET = "";
    expect(listExtraMetaApps()).toEqual([]);
    expect(hasMultipleMetaApps()).toBe(false);
  });

  it("does NOT register an app with only its id set", () => {
    configureLegacy();
    process.env.META_APP_2_ID = APP_B;
    expect(listExtraMetaApps()).toEqual([]);
  });

  it("does NOT register an app with only its secret set", () => {
    configureLegacy();
    process.env.META_APP_2_SECRET = "secret-b";
    expect(listExtraMetaApps()).toEqual([]);
  });

  it("treats a whitespace-only value as missing", () => {
    configureLegacy();
    process.env.META_APP_2_ID = "   ";
    process.env.META_APP_2_SECRET = "secret-b";
    expect(listExtraMetaApps()).toEqual([]);
  });

  it("registers the app only when BOTH halves are non-empty", () => {
    configureLegacy();
    process.env.META_APP_2_ID = APP_B;
    process.env.META_APP_2_SECRET = "secret-b";
    expect(listExtraMetaApps()).toEqual([
      { appId: APP_B, clientId: APP_B, clientSecret: "secret-b", legacy: false },
    ]);
    expect(hasMultipleMetaApps()).toBe(true);
  });
});

describe("meta-app-registry — resolution", () => {
  beforeEach(() => {
    configureLegacy();
    process.env.META_APP_2_ID = APP_B;
    process.env.META_APP_2_SECRET = "secret-b";
  });

  it("resolves app B by id, for either platform", () => {
    expect(resolveMetaCredentials("FACEBOOK", APP_B)?.clientSecret).toBe("secret-b");
    expect(resolveMetaCredentials("INSTAGRAM", APP_B)?.clientSecret).toBe("secret-b");
  });

  it("returns null for an unknown app — never a silent fallback to app A", () => {
    // Falling back would publish with the wrong app's secret. A clean null,
    // surfaced as "not configured", is strictly safer.
    expect(resolveMetaCredentials("FACEBOOK", "999999999")).toBeNull();
  });

  // `wanted in obj` would match these; `find` over an array does not.
  it.each(["__proto__", "constructor", "toString", "valueOf"])(
    "returns null for the prototype-pollution id %s",
    (evil) => {
      expect(resolveMetaCredentials("FACEBOOK", evil)).toBeNull();
      expect(isKnownMetaAppId("FACEBOOK", evil)).toBe(false);
    }
  );

  it("reads env at CALL time, not module-load time", () => {
    expect(resolveMetaCredentials("FACEBOOK", APP_B)?.clientSecret).toBe("secret-b");
    process.env.META_APP_2_SECRET = "rotated";
    expect(resolveMetaCredentials("FACEBOOK", APP_B)?.clientSecret).toBe("rotated");
  });
});

describe("listMetaWebhookSecrets", () => {
  it("dedupes the identical FACEBOOK/INSTAGRAM legacy secret", () => {
    configureLegacy(); // both pairs hold "secret-a"
    expect(listMetaWebhookSecrets()).toEqual([{ appId: APP_A, secret: "secret-a" }]);
  });

  it("returns one entry per distinct app when they differ", () => {
    configureLegacy();
    process.env.META_APP_2_ID = APP_B;
    process.env.META_APP_2_SECRET = "secret-b";
    expect(listMetaWebhookSecrets()).toEqual([
      { appId: APP_A, secret: "secret-a" },
      { appId: APP_B, secret: "secret-b" },
    ]);
  });

  // 🔴 An empty secret is an AUTH BYPASS, not a disabled feature:
  // createHmac("sha256","") yields a valid, attacker-computable digest.
  it("never emits an empty secret as a candidate", () => {
    configureLegacy();
    process.env.META_APP_2_ID = APP_B;
    process.env.META_APP_2_SECRET = "";
    const secrets = listMetaWebhookSecrets();
    expect(secrets.every((s) => s.secret.length > 0)).toBe(true);
    expect(secrets.map((s) => s.appId)).not.toContain(APP_B);
  });

  it("is empty when nothing is configured", () => {
    expect(listMetaWebhookSecrets()).toEqual([]);
  });
});

describe("verifyMetaWebhookSignature", () => {
  const BODY = JSON.stringify({ object: "page", entry: [{ id: "1" }] });
  const sign = (secret: string, body = BODY) =>
    "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

  const CANDIDATES = [
    { appId: APP_A, secret: "secret-a" },
    { appId: APP_B, secret: "secret-b" },
  ];

  it("accepts a signature from app A and reports WHICH app matched", () => {
    expect(verifyMetaWebhookSignature(BODY, sign("secret-a"), CANDIDATES)).toEqual({
      ok: true,
      appId: APP_A,
    });
  });

  it("accepts a signature from app B and reports WHICH app matched", () => {
    expect(verifyMetaWebhookSignature(BODY, sign("secret-b"), CANDIDATES)).toEqual({
      ok: true,
      appId: APP_B,
    });
  });

  it("rejects a signature from neither secret", () => {
    expect(verifyMetaWebhookSignature(BODY, sign("secret-c"), CANDIDATES)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a valid signature over a DIFFERENT body", () => {
    const other = sign("secret-a", JSON.stringify({ object: "page", entry: [] }));
    expect(verifyMetaWebhookSignature(BODY, other, CANDIDATES).ok).toBe(false);
  });

  it("fails closed when no app is configured", () => {
    expect(verifyMetaWebhookSignature(BODY, sign("secret-a"), [])).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  // 🔴 REGRESSION LOCK for the live 500. The old guard compared JS STRING
  // length then called timingSafeEqual, which compares BYTE length — a
  // 71-char header carrying one 2-byte UTF-8 char passed the guard at 72
  // bytes and threw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH out of the route.
  it("does not throw on a header whose string length matches but byte length does not", () => {
    const evil = "sha256=" + "Ã" + "a".repeat(63);
    const expected = "sha256=" + "a".repeat(64);
    expect(evil.length).toBe(expected.length); // string lengths agree...
    expect(Buffer.from(evil).length).not.toBe(Buffer.from(expected).length); // ...bytes do not

    expect(() => verifyMetaWebhookSignature(BODY, evil, CANDIDATES)).not.toThrow();
    expect(verifyMetaWebhookSignature(BODY, evil, CANDIDATES)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it.each([
    ["empty", ""],
    ["missing prefix", "a".repeat(64)],
    ["wrong algorithm", "sha1=" + "a".repeat(64)],
    ["too short", "sha256=" + "a".repeat(63)],
    ["too long", "sha256=" + "a".repeat(65)],
    ["uppercase hex", "sha256=" + "A".repeat(64)],
    ["non-hex", "sha256=" + "z".repeat(64)],
    ["trailing space", "sha256=" + "a".repeat(64) + " "],
  ])("rejects a malformed header (%s) without hashing", (_label, header) => {
    expect(verifyMetaWebhookSignature(BODY, header, CANDIDATES)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it.each([null, undefined])("rejects a %s header", (header) => {
    expect(verifyMetaWebhookSignature(BODY, header as null, CANDIDATES)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("never accepts an empty-secret candidate even if one is passed directly", () => {
    const forged = "sha256=" + crypto.createHmac("sha256", "").update(BODY, "utf8").digest("hex");
    expect(verifyMetaWebhookSignature(BODY, forged, [{ appId: "x", secret: "" }]).ok).toBe(false);
  });
});
