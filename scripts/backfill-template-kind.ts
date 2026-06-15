/**
 * scripts/backfill-template-kind.ts
 *
 * One-time (idempotent) backfill: sets kind = 'logo' for every CreativeTemplate
 * that has a logoMediaId but no referenceMediaId (i.e. it is a brand logo, not a
 * saved style reference). All other rows remain 'style' (the column default).
 *
 * Safe to re-run — the WHERE clause only touches rows that still have the default
 * 'style' kind but are structurally logo templates.
 *
 * Usage:
 *   pnpm db:backfill-template-kind
 *   # or directly:
 *   cd packages/db && pnpm exec tsx ../../scripts/backfill-template-kind.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Backfilling CreativeTemplate.kind …\n");

  const result = await prisma.creativeTemplate.updateMany({
    where: {
      referenceMediaId: null,
      logoMediaId: { not: null },
      kind: "style", // only touch rows still carrying the default — idempotent
    },
    data: { kind: "logo" },
  });

  console.log(`  Updated ${result.count} row(s) to kind = 'logo'.`);
  console.log("  All rows with referenceMediaId remain kind = 'style' (correct default).");
  console.log("\nBackfill complete.");
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
