import crypto from "crypto";

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

export function encryptToken(token: string): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || "";
  const iv = crypto.randomBytes(16);
  const keyBuffer = Buffer.from(key.padEnd(32).slice(0, 32), "utf8");
  const cipher = crypto.createCipheriv("aes-256-cbc", keyBuffer, iv);
  let encrypted = cipher.update(token, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

export function decryptToken(encryptedToken: string): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || "";
  const parts = encryptedToken.split(":");
  const ivHex = parts[0] ?? "";
  const encrypted = parts[1] ?? "";
  const iv = Buffer.from(ivHex, "hex");
  const keyBuffer = Buffer.from(key.padEnd(32).slice(0, 32), "utf8");
  const decipher = crypto.createDecipheriv("aes-256-cbc", keyBuffer, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
