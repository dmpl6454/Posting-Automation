import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IMPERSONATION_COOKIE,
  clearImpersonationClientState,
  clearImpersonationCookie,
  hasImpersonationCookie,
} from "./impersonation-client";

/**
 * Exiting impersonation must always drop the client-side state. The cookie is
 * JS-set and survives sign-out, so a stranded cookie (banner stuck on screen,
 * or carried into the next account's session on the same browser) is the
 * failure mode these lock out.
 */

// Minimal document.cookie emulation: assignments append, reads see the last
// write per cookie name, and an expired write deletes.
function fakeDocument(initial: Record<string, string>) {
  const jar = new Map(Object.entries(initial));
  return {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(v: string) {
      const [pair, ...attrs] = v.split(";").map((s) => s.trim());
      const name = pair!.slice(0, pair!.indexOf("="));
      const value = pair!.slice(pair!.indexOf("=") + 1);
      const expired = attrs.some((a) => /^expires=Thu, 01 Jan 1970/i.test(a) || a === "max-age=0");
      if (expired) jar.delete(name);
      else jar.set(name, value);
    },
  };
}

function fakeStorage(initial: Record<string, string>) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    removeItem: (k: string) => void m.delete(k),
    has: (k: string) => m.has(k),
  };
}

describe("impersonation client helpers", () => {
  it("detects the cookie regardless of position", () => {
    expect(hasImpersonationCookie(`a=1; ${IMPERSONATION_COOKIE}=tok`)).toBe(true);
    expect(hasImpersonationCookie(`${IMPERSONATION_COOKIE}=tok`)).toBe(true);
    expect(hasImpersonationCookie("a=1; x-admin-impersonate=tok")).toBe(false);
    expect(hasImpersonationCookie("")).toBe(false);
  });

  it("clearImpersonationCookie expires the cookie at path=/", () => {
    const doc = fakeDocument({ [IMPERSONATION_COOKIE]: "tok", other: "keep" });
    clearImpersonationCookie(doc);
    expect(hasImpersonationCookie(doc.cookie)).toBe(false);
    expect(doc.cookie).toContain("other=keep");
  });

  it("clearImpersonationClientState also drops the impersonated user's currentOrgId", () => {
    const doc = fakeDocument({ [IMPERSONATION_COOKIE]: "tok" });
    const storage = fakeStorage({ currentOrgId: "org-of-target", unrelated: "x" });
    clearImpersonationClientState(doc, storage);
    expect(hasImpersonationCookie(doc.cookie)).toBe(false);
    expect(storage.has("currentOrgId")).toBe(false);
    expect(storage.has("unrelated")).toBe(true);
  });

  it("clearImpersonationClientState never throws when storage is unavailable", () => {
    const doc = fakeDocument({ [IMPERSONATION_COOKIE]: "tok" });
    const broken = {
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => clearImpersonationClientState(doc, broken)).not.toThrow();
    expect(hasImpersonationCookie(doc.cookie)).toBe(false);
  });
});

const ROOT = join(__dirname, "..", "..", "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const read = (p: string) => strip(readFileSync(join(ROOT, p), "utf8"));

describe("ImpersonationBanner clears client state whatever the server says", () => {
  const src = read("apps/web/components/admin/ImpersonationBanner.tsx");
  const mutation = src.slice(
    src.indexOf("stopImpersonation.useMutation("),
    src.indexOf("useEffect(", src.indexOf("stopImpersonation.useMutation(")),
  );

  it("does the cleanup in onSettled, not onSuccess", () => {
    // onSuccess-only cleanup stranded the banner + cookie whenever the server
    // refused (superseded jti, demoted admin, expired token, network error).
    expect(mutation).toMatch(/onSettled\s*:/);
    expect(mutation).not.toMatch(/onSuccess\s*:/);
    const settled = mutation.slice(mutation.indexOf("onSettled"));
    expect(settled).toMatch(/clearImpersonationClientState\(\)/);
  });

  it("detects the cookie through the shared helper", () => {
    expect(src).toMatch(/hasImpersonationCookie\(document\.cookie\)/);
  });
});

describe("signing out drops the impersonation cookie first", () => {
  for (const file of [
    "apps/web/components/admin/AdminSidebar.tsx",
    "apps/web/components/layout/header.tsx",
  ]) {
    it(`${file}: every signOut( is preceded by clearImpersonationCookie()`, () => {
      const src = read(file);
      const calls = [...src.matchAll(/signOut\(\{/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const m of calls) {
        // Same handler: the clear must sit just before the signOut call.
        const before = src.slice(Math.max(0, m.index! - 120), m.index!);
        expect(before).toMatch(/clearImpersonationCookie\(\);\s*(void\s+)?$/);
      }
    });
  }
});
