/**
 * Guard for the S3 credential pre-flight (audit #17). Uploads should fail with a
 * clear "storage not configured" message instead of an opaque empty-credential
 * S3 error when neither key/secret var is set.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isS3Configured } from "../lib/s3";

const KEYS = ["S3_ACCESS_KEY_ID", "S3_ACCESS_KEY", "S3_SECRET_ACCESS_KEY", "S3_SECRET_KEY"];
const saved: Record<string, string | undefined> = {};
function clearAll() { KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); }

describe("isS3Configured", () => {
  afterEach(() => { KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it("false when no credential vars are set", () => {
    clearAll();
    expect(isS3Configured()).toBe(false);
  });

  it("true with the AWS-standard pair", () => {
    clearAll();
    process.env.S3_ACCESS_KEY_ID = "minioadmin";
    process.env.S3_SECRET_ACCESS_KEY = "minioadmin";
    expect(isS3Configured()).toBe(true);
  });

  it("true with the short-name fallback pair", () => {
    clearAll();
    process.env.S3_ACCESS_KEY = "minioadmin";
    process.env.S3_SECRET_KEY = "minioadmin";
    expect(isS3Configured()).toBe(true);
  });

  it("false when only the key is set (missing secret)", () => {
    clearAll();
    process.env.S3_ACCESS_KEY_ID = "minioadmin";
    expect(isS3Configured()).toBe(false);
  });
});
