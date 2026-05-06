import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────
// Token encryption at rest (AES-256-GCM with authentication tag)
// ─────────────────────────────────────────────────────────────────────
// Lives in @postautomation/db so the Prisma client extension can use it
// without importing from @postautomation/social (which would create a
// circular dependency, since social itself depends on db for types).
//
// Format: `enc:v1:<base64url(iv)>:<base64url(authTag)>:<base64url(ciphertext)>`
//
// - Idempotent: encrypting an already-encrypted value returns it unchanged.
// - Backward compatible: legacy plaintext rows decrypt to themselves.
//   Old AES-256-CBC encrypted rows (`<32 hex>:<hex>`) are also decrypted
//   transparently for migration purposes.

const ENC_PREFIX = "enc:v1:";

function getEncryptionKey(): Buffer {
  const k = process.env.TOKEN_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET;
  if (!k || k.length < 16) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY (or NEXTAUTH_SECRET) must be set to a strong value (>=16 chars) for token encryption"
    );
  }
  return crypto.createHash("sha256").update(k).digest();
}

export function encryptToken(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === "") return null;
  if (typeof plaintext === "string" && plaintext.startsWith(ENC_PREFIX)) {
    return plaintext;
  }
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

export function decryptToken(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (!value.startsWith(ENC_PREFIX)) {
    // Legacy CBC format from earlier helper
    if (/^[0-9a-f]{32}:[0-9a-f]+$/i.test(value)) {
      try {
        const [ivHex, ctHex] = value.split(":") as [string, string];
        const key = getEncryptionKey();
        const iv = Buffer.from(ivHex, "hex");
        const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
        let pt = decipher.update(ctHex, "hex", "utf8");
        pt += decipher.final("utf8");
        return pt;
      } catch {
        return value;
      }
    }
    return value; // legacy plaintext
  }
  const rest = value.slice(ENC_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted token");
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return pt;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}
