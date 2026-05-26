import { NextResponse } from "next/server";
import { prisma } from "@postautomation/db";

/**
 * GET /api/auth/check-email?email=...
 *
 * Returns which sign-in methods are linked to this email so the
 * login page can show a helpful error (e.g. "use Google instead").
 * Only returns method names — never passwords or tokens.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get("email")?.toLowerCase().trim();

  if (!email) return NextResponse.json({ methods: [] });

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: {
      password: true,
      accounts: { select: { provider: true } },
    },
  });

  if (!user) return NextResponse.json({ methods: [] });

  const methods: string[] = [];
  if (user.password) methods.push("credentials");
  user.accounts.forEach((a) => methods.push(a.provider));

  return NextResponse.json({ methods });
}
