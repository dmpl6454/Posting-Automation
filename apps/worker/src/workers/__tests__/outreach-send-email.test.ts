/**
 * Regression guard for BO-01: outreach EMAIL used to be hard-wired to Resend,
 * which throws when RESEND_API_KEY is unset (it's intentionally blank in
 * production). SMTP (Google Workspace) IS configured in prod and already used
 * for password-reset email — this locks in that outreach email routes through
 * it as a fallback when Resend isn't configured.
 *
 * Contract (see dispatchOutreachEmail in ../outreach-send.worker.ts):
 *   - Resend configured (RESEND_API_KEY set) → primary, unchanged behavior.
 *   - Otherwise, SMTP configured (SMTP_HOST set) → send via nodemailer.
 *   - Neither configured → throw (never silently/falsely report "sent").
 * The worker's dev-console-preview fallback (when SMTP_HOST is unset) must
 * NEVER be reachable from dispatchOutreachEmail's "sent" branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMailMock = vi.fn();
const createTransportMock = vi.fn((_options: unknown) => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: (options: unknown) => createTransportMock(options) },
  createTransport: (options: unknown) => createTransportMock(options),
}));

import { dispatchOutreachEmail } from "../outreach-send.worker";

describe("dispatchOutreachEmail", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    sendMailMock.mockReset();
    createTransportMock.mockClear();
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("uses SMTP and returns 'sent' when SMTP is configured and Resend is not", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_USER = "hr@digitalsukoon.com";
    process.env.SMTP_PASS = "app-password";
    sendMailMock.mockResolvedValue({ messageId: "abc" });

    const out = await dispatchOutreachEmail("m1", "Hi", "body text", "brand@x.com");

    expect(out).toBe("sent");
    expect(sendMailMock).toHaveBeenCalledOnce();
    expect(sendMailMock.mock.calls[0]?.[0]).toMatchObject({
      to: "brand@x.com",
      subject: "Hi",
    });
  });

  it("throws when SMTP delivery fails (transport rejects)", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.SMTP_HOST = "smtp.gmail.com";
    sendMailMock.mockRejectedValue(new Error("connection refused"));

    await expect(
      dispatchOutreachEmail("m1", "Hi", "b", "brand@x.com"),
    ).rejects.toThrow(/SMTP/i);
  });

  it("throws when neither Resend nor SMTP is configured (no false 'sent')", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;

    await expect(
      dispatchOutreachEmail("m1", "Hi", "b", "brand@x.com"),
    ).rejects.toThrow(/no email provider configured/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
