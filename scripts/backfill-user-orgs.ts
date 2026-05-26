/**
 * scripts/backfill-user-orgs.ts
 *
 * One-time (idempotent) backfill: creates a personal workspace organisation for
 * every user who has no organisation membership.
 *
 * This covers OAuth users who signed up before `events.createUser` was added to
 * the auth config, as well as any edge-case credentials users whose org creation
 * somehow failed.
 *
 * Safe to re-run — it skips users who already have at least one membership.
 *
 * Usage:
 *   pnpm db:backfill-orgs
 *   # or directly:
 *   cd packages/db && pnpm exec tsx ../../scripts/backfill-user-orgs.ts
 */

import { prisma } from "@postautomation/db";

async function main() {
  console.log("🔍  Finding users with no organisation membership…\n");

  // Fetch every user that has zero OrganizationMember rows
  const usersWithoutOrg = await prisma.user.findMany({
    where: {
      memberships: { none: {} },
    },
    select: {
      id: true,
      email: true,
      name: true,
      deletedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (usersWithoutOrg.length === 0) {
    console.log("✅  All users already have an organisation. Nothing to do.");
    return;
  }

  console.log(`Found ${usersWithoutOrg.length} user(s) without an organisation:\n`);

  let created = 0;
  let skipped = 0;

  for (const user of usersWithoutOrg) {
    // Skip soft-deleted accounts — no point creating an org for them
    if (user.deletedAt) {
      console.log(`  ⏭   SKIP  ${user.email ?? user.id}  (soft-deleted)`);
      skipped++;
      continue;
    }

    // Derive a slug from the email local-part (same logic as register route + events.createUser)
    const emailLocalPart = (user.email?.split("@")[0] ?? user.id)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    const displayName = user.name || emailLocalPart;
    const orgName = `${displayName}'s Workspace`;
    const orgSlug = `${emailLocalPart}-${Date.now().toString(36)}`;

    try {
      await prisma.organization.create({
        data: {
          name: orgName,
          slug: orgSlug,
          members: {
            create: {
              userId: user.id,
              role: "OWNER",
            },
          },
        },
      });

      console.log(`  ✅  CREATED  "${orgName}"  →  ${user.email ?? user.id}`);
      created++;
    } catch (err: any) {
      // Slug collision is extremely unlikely given the timestamp suffix,
      // but handle it gracefully so the rest of the users still get processed.
      console.error(`  ❌  FAILED   ${user.email ?? user.id}:`, err.message);
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`  Created : ${created}`);
  console.log(`  Skipped : ${skipped}  (soft-deleted)`);
  console.log(`  Total   : ${usersWithoutOrg.length}`);
  console.log(`─────────────────────────────────────────`);
  console.log(`\nBackfill complete.`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
