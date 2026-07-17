/**
 * One-time RBAC grandfathering: every user created BEFORE the cutoff becomes
 * appRole=ADMIN (product decision 2026-07-17: existing users keep full access;
 * only NEW signups default to USER).
 *
 * Idempotent: re-runs are no-ops (the predicate excludes already-promoted rows).
 * The cutoff is an explicit required env var so a later accidental re-run cannot
 * wrongly promote users who signed up after RBAC shipped.
 *
 * Run (local):
 *   RBAC_ADMIN_CUTOFF=2026-07-18T00:00:00Z pnpm tsx scripts/backfill-app-roles.ts
 *
 * Run (production, from the web container — mirrors backfill-user-orgs.ts):
 *   docker exec -e RBAC_ADMIN_CUTOFF=<ISO datetime> postautomation-web-1 \
 *     sh -c 'cd /app && NODE_PATH=/app/packages/db/node_modules /app/packages/db/node_modules/.bin/tsx scripts/backfill-app-roles.ts'
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const cutoffIso = process.env.RBAC_ADMIN_CUTOFF;
  if (!cutoffIso || Number.isNaN(Date.parse(cutoffIso))) {
    console.error(
      "Set RBAC_ADMIN_CUTOFF=<ISO datetime>. Users created BEFORE it are promoted to appRole=ADMIN."
    );
    process.exit(1);
  }
  const cutoff = new Date(cutoffIso);
  console.log(`Grandfathering users created before ${cutoff.toISOString()} to appRole=ADMIN…`);

  const candidates = await prisma.user.count({
    where: { appRole: "USER", createdAt: { lt: cutoff } },
  });
  if (candidates === 0) {
    console.log("Nothing to do — all pre-cutoff users are already ADMIN.");
  } else {
    const res = await prisma.user.updateMany({
      where: { appRole: "USER", createdAt: { lt: cutoff } },
      data: { appRole: "ADMIN" },
    });
    console.log(`Promoted ${res.count} pre-cutoff user(s) to appRole=ADMIN.`);
  }

  const [admins, users, supers] = await Promise.all([
    prisma.user.count({ where: { appRole: "ADMIN" } }),
    prisma.user.count({ where: { appRole: "USER" } }),
    prisma.user.count({ where: { isSuperAdmin: true } }),
  ]);
  console.log(`Totals now: appRole=ADMIN: ${admins} · appRole=USER: ${users} · superAdmins: ${supers}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
