import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@postautomation/db";
import { ensurePersonalOrg } from "@postautomation/db";
import { sendEmail } from "@postautomation/api/src/lib/email";
import { accountAlreadyExistsEmail } from "@postautomation/api/src/lib/email-templates";
import { decideRegisterAction } from "~/lib/register-response";

export async function POST(req: Request) {
  try {
    const { name, email, password } = await req.json();

    if (!email || !password || password.length < 8) {
      return NextResponse.json(
        { error: "Valid email and password (8+ chars) required" },
        { status: 400 }
      );
    }

    // Normalize email — prevents case-sensitivity duplicates
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      select: { password: true, accounts: { select: { provider: true } } },
    });

    // Security audit 2026-09-28: never let the response reveal whether this
    // email already has an account — that used to be a direct, unauthenticated
    // existence (and OAuth-provider-fingerprinting) oracle: a distinct HTTP
    // status (409 vs 200) and, for an OAuth-only email, the exact provider
    // name in the message body. Mirrors requestPasswordReset's existing "same
    // response either way" invariant. A real owner is told over email
    // instead, never in the API response body.
    const decision = decideRegisterAction(existing);

    if (decision.action === "notify-existing") {
      const emailContent = accountAlreadyExistsEmail(decision.oauthProviders);
      sendEmail({
        to: normalizedEmail,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
      }).catch(() => {}); // Non-blocking — never let mail delivery affect the response
      return NextResponse.json({ success: true });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        name,
        email: normalizedEmail,
        password: hashedPassword,
        emailVerified: new Date(),
      },
    });

    // S2: idempotent single-org provisioning (pre-authorised emails get the
    // ENTERPRISE trial inside the helper). If this email already OWNs an org
    // from a prior OAuth sign-up, it's reused rather than duplicated.
    await ensurePersonalOrg(prisma, user.id, normalizedEmail);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Registration error:", err);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
