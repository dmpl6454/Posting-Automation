import { describe, it, expect } from "vitest";
import { decideRegisterAction } from "./register-response";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("decideRegisterAction", () => {
  it("creates a new account when no existing row is found", () => {
    expect(decideRegisterAction(null)).toEqual({ action: "create" });
  });

  it("notifies instead of creating when the email already has a credentials account", () => {
    expect(decideRegisterAction({ password: "hash", accounts: [] })).toEqual({
      action: "notify-existing",
      oauthProviders: [],
    });
  });

  it("notifies instead of creating when the email is OAuth-only", () => {
    expect(decideRegisterAction({ password: null, accounts: [{ provider: "google" }] })).toEqual({
      action: "notify-existing",
      oauthProviders: ["google"],
    });
  });
});

describe("register route — response shape is identical whether or not the email exists (source lock)", () => {
  // apps/web/app/** is excluded from this repo's vitest include globs
  // (CLAUDE.md), so the invariant that actually closes the enumeration gap —
  // ONE response shape for every case — is locked here by reading the
  // route's source rather than executing it. Comments are stripped first: a
  // note that QUOTES the banned shape (as this file's own comments do, to
  // explain what was removed) must not fail the lock.
  const rawSrc = readFileSync(join(__dirname, "../app/api/auth/register/route.ts"), "utf8");
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("never returns a 409 (or any status distinguishing 'already registered')", () => {
    expect(src).not.toMatch(/409/);
  });

  it("never puts the word 'registered' in a response body (the old distinguishing message)", () => {
    expect(src.toLowerCase()).not.toMatch(/already registered/);
  });

  it("uses decideRegisterAction rather than branching inline on `existing`", () => {
    expect(src).toMatch(/decideRegisterAction/);
  });
});
