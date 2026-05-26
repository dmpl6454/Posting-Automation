import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@postautomation/db";

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

    if (existing) {
      // Tell the user which OAuth provider to use instead of giving a generic error
      const oauthProviders = existing.accounts.map((a) => a.provider);
      if (oauthProviders.length > 0 && !existing.password) {
        const names = oauthProviders
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join(" or ");
        return NextResponse.json(
          {
            error: `This email is already registered via ${names}. Please sign in using the ${names} button instead.`,
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "Email already registered" }, { status: 409 });
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

    // Auto-create a personal organization
    const slug = email.split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
    await prisma.organization.create({
      data: {
        name: `${name || slug}'s Workspace`,
        slug: `${slug}-${Date.now().toString(36)}`,
        members: {
          create: {
            userId: user.id,
            role: "OWNER",
          },
        },
      },
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Registration error:", err);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
