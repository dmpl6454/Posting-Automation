/**
 * Grant isSuperAdmin + OWNER role to a specific user.
 * Works on both local dev and production.
 *
 * Usage (local):
 *   NODE_PATH=packages/db/node_modules pnpm exec tsx scripts/grant-superadmin.ts
 *
 * Usage (production via docker exec):
 *   docker exec postautomation-web-1 sh -c \
 *     'cd /app && NODE_PATH=/app/packages/db/node_modules /app/packages/db/node_modules/.bin/tsx scripts/grant-superadmin.ts'
 */
import { prisma } from "@postautomation/db";

const TARGET_EMAIL = "tabish@dashmani.com";

async function main() {
  // 1. Find the user
  const user = await prisma.user.findUnique({
    where: { email: TARGET_EMAIL },
    select: { id: true, email: true, name: true, isSuperAdmin: true },
  });

  if (!user) {
    console.error(`❌  User not found: ${TARGET_EMAIL}`);
    console.error("    Make sure the user has registered first, then re-run this script.");
    process.exit(1);
  }

  console.log(`✅  Found user: ${user.name ?? "(no name)"} <${user.email}> (id: ${user.id})`);

  // 2. Grant isSuperAdmin at the User level
  await prisma.user.update({
    where: { id: user.id },
    data: { isSuperAdmin: true },
  });
  console.log("✅  isSuperAdmin = true");

  // 3. Find all org memberships for this user
  const memberships = await prisma.organizationMember.findMany({
    where: { userId: user.id },
    include: { organization: { select: { name: true, slug: true } } },
  });

  if (memberships.length === 0) {
    // No org yet — create a personal workspace and make them OWNER
    const slug = TARGET_EMAIL.split("@")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const org = await prisma.organization.create({
      data: {
        name: "tabish's Workspace",
        slug: `${slug}-${Date.now().toString(36)}`,
        members: {
          create: {
            userId: user.id,
            role: "OWNER",
          },
        },
      },
    });
    console.log(`✅  Created personal workspace "${org.name}" and assigned OWNER`);
  } else {
    // Promote ALL existing memberships to OWNER
    for (const m of memberships) {
      if (m.role !== "OWNER") {
        await prisma.organizationMember.update({
          where: { id: m.id },
          data: { role: "OWNER" },
        });
        console.log(`✅  Promoted to OWNER in org: "${m.organization.name}" (${m.organization.slug})`);
      } else {
        console.log(`ℹ️   Already OWNER in org: "${m.organization.name}" (${m.organization.slug})`);
      }
    }
  }

  console.log("\n🎉  Done! Changes take effect on the user's next sign-in (or session refresh).");
  console.log("    The user must sign out and sign back in for the new role to appear in their JWT.");
}

main()
  .catch((err) => {
    console.error("❌  Script failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
