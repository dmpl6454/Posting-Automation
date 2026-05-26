import { z } from "zod";

/**
 * Regex covering private / loopback / link-local IPv4 ranges and localhost.
 * Used to prevent SSRF via webhook URLs.
 */
const PRIVATE_HOST_RE =
  /^(localhost|0(\.0){0,3}|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i;

/**
 * Zod schema for webhook URLs.
 * - Must be a valid URL.
 * - Must use HTTPS.
 * - Must not point to a private / loopback / link-local address.
 */
export const webhookUrlSchema = z
  .string()
  .url({ message: "Must be a valid URL" })
  .refine(
    (s) => {
      try {
        const u = new URL(s);
        if (u.protocol !== "https:") return false;
        if (PRIVATE_HOST_RE.test(u.hostname)) return false;
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        "URL must use HTTPS and must not point to a private or loopback address",
    }
  );
