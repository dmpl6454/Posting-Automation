import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { phoneCardMode } from "./phone-settings";

/**
 * Settings → Mobile Number after the addPhone step-up (security review
 * 2026-10-01). Replacing a verified phone with a different number now
 * requires `currentPassword`, but the card only ever sent `{ phone }` — so
 * every "Change Number" attempt was rejected. An account with no password
 * cannot pass the step-up at all and is pointed at Remove Number instead.
 */
describe("phoneCardMode", () => {
  it("offers a plain add when there is no phone yet", () => {
    expect(phoneCardMode({ phone: null, hasPassword: true })).toBe("add");
    expect(phoneCardMode({ phone: null, hasPassword: false })).toBe("add");
    expect(phoneCardMode(undefined)).toBe("add");
  });

  it("asks for the current password to change an existing number", () => {
    expect(phoneCardMode({ phone: "+15551234567", hasPassword: true })).toBe("change");
  });

  it("only offers removal when the account has no password to step up with", () => {
    expect(phoneCardMode({ phone: "+15551234567", hasPassword: false })).toBe("remove-only");
    expect(phoneCardMode({ phone: "+15551234567" })).toBe("remove-only");
  });
});

const ROOT = join(__dirname, "..", "..", "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const settings = strip(readFileSync(join(ROOT, "apps/web/app/dashboard/settings/page.tsx"), "utf8"));
const resetPage = strip(readFileSync(join(ROOT, "apps/web/app/(auth)/reset-password/page.tsx"), "utf8"));

describe("Settings phone card (source contract)", () => {
  it("derives its mode from phoneCardMode", () => {
    expect(settings).toMatch(/phoneCardMode\(/);
  });

  it("sends the phone card's OWN current-password state with a change", () => {
    expect(settings).toMatch(/addPhone\.mutate\([^;]*currentPassword:\s*phoneCurrentPassword/);
    // Not the Password card's field — two inputs must not share one state.
    expect(settings).not.toMatch(/addPhone\.mutate\([^;]*currentPassword:\s*currentPassword\b/);
    expect(settings).toMatch(/\[phoneCurrentPassword,\s*setPhoneCurrentPassword\]\s*=\s*useState/);
  });

  it("renders a current-password input for a change", () => {
    expect(settings).toMatch(/value=\{phoneCurrentPassword\}/);
    expect(settings).toMatch(/type="password"/);
  });

  it("hides Change Number and explains removal when there is no password", () => {
    expect(settings).toMatch(/phoneMode === "remove-only"/);
    expect(settings).toMatch(/remove this one first/);
  });
});

describe("Reset-password success screen", () => {
  it("tells the user phone sign-in was removed, when it was", () => {
    expect(resetPage).toMatch(/phoneRemoved/);
    expect(resetPage).toMatch(/For your security, phone sign-in was removed\./);
    expect(resetPage).toMatch(/Re-add your number in Settings if you use it\./);
  });
});
