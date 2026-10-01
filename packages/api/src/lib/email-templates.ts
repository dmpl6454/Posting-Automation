const APP_NAME = "PostAutomation";

function baseTemplate(content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#18181b;padding:24px 32px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;">${APP_NAME}</h1>
    </div>
    <div style="padding:32px;">${content}</div>
    <div style="padding:16px 32px;background:#f4f4f5;text-align:center;font-size:12px;color:#71717a;">
      <p style="margin:0;">&copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;
}

export function passwordResetEmail(resetUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: `Reset your ${APP_NAME} password`,
    html: baseTemplate(`
      <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">Reset Your Password</h2>
      <p style="color:#3f3f46;line-height:1.6;">We received a request to reset your password. Click the button below to choose a new one.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${resetUrl}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:500;">Reset Password</a>
      </div>
      <p style="color:#71717a;font-size:13px;line-height:1.5;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
      <p style="color:#71717a;font-size:12px;word-break:break-all;">Or copy this link: ${resetUrl}</p>
    `),
    text: `Reset your ${APP_NAME} password\n\nVisit this link to reset your password: ${resetUrl}\n\nThis link expires in 1 hour.`,
  };
}

export function emailVerificationEmail(verifyUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: `Verify your ${APP_NAME} email`,
    html: baseTemplate(`
      <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">Verify Your Email</h2>
      <p style="color:#3f3f46;line-height:1.6;">Thanks for signing up! Please verify your email address to get started.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${verifyUrl}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:500;">Verify Email</a>
      </div>
      <p style="color:#71717a;font-size:13px;line-height:1.5;">This link expires in 24 hours.</p>
      <p style="color:#71717a;font-size:12px;word-break:break-all;">Or copy this link: ${verifyUrl}</p>
    `),
    text: `Verify your ${APP_NAME} email\n\nVisit this link: ${verifyUrl}\n\nThis link expires in 24 hours.`,
  };
}

/**
 * Security notification (2026-09-28 security audit — closes the gap where a
 * phone login method could be attached to an account with zero signal to the
 * account owner). Sent to the account's REGISTERED email — not whichever
 * session is currently acting as the account — so it reaches the real owner
 * even if the phone was added by someone else via a hijacked session. Only
 * the last 4 digits are shown, matching the common "ending in ####" pattern
 * for this kind of alert.
 */
export function phoneChangedEmail(
  phone: string,
  { hasPassword = true }: { hasPassword?: boolean } = {}
): { subject: string; html: string; text: string } {
  const last4 = phone.replace(/\D/g, "").slice(-4);
  // A password reset removes the phone too. Removing it from Settings needs a
  // code sent to that (possibly attacker's) phone, and requestPasswordReset
  // does nothing for an account with no password — hence the two variants.
  const remedy = hasPassword
    ? "reset your password now with Forgot password on the sign-in page — that also removes this phone number."
    : "set a password in Settings, then use Forgot password on the sign-in page — that also removes this phone number.";
  return {
    subject: `A phone number was added to your ${APP_NAME} account`,
    html: baseTemplate(`
      <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">Phone Number Added</h2>
      <p style="color:#3f3f46;line-height:1.6;">A phone number ending in <strong>${last4}</strong> was just added as a sign-in method on your account.</p>
      <p style="color:#71717a;font-size:13px;line-height:1.5;">If this was you, no action is needed. If you don't recognize this change, ${remedy}</p>
    `),
    text: `A phone number ending in ${last4} was just added as a sign-in method on your ${APP_NAME} account.\n\nIf this wasn't you, ${remedy}`,
  };
}

export function teamInviteEmail(inviterName: string, orgName: string, loginUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: `You've been invited to ${orgName} on ${APP_NAME}`,
    html: baseTemplate(`
      <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">Team Invitation</h2>
      <p style="color:#3f3f46;line-height:1.6;"><strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on ${APP_NAME}.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${loginUrl}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:500;">Accept Invitation</a>
      </div>
    `),
    text: `${inviterName} invited you to join ${orgName} on ${APP_NAME}.\n\nLogin: ${loginUrl}`,
  };
}
