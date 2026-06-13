-- Saved style-reference library (Component 9 / D8): add resolved CardSpec + a
-- reference-image relation + provenance URL to CreativeTemplate. All additive +
-- nullable (no data loss). Prod applies the schema via `prisma db push`; this
-- file documents the change for history (mirrors the existing hand-authored
-- one_owner_org_per_user migration).

-- AlterTable
ALTER TABLE "CreativeTemplate" ADD COLUMN     "cardSpec" JSONB,
ADD COLUMN     "referenceMediaId" TEXT,
ADD COLUMN     "sourceUrl" TEXT;

-- AddForeignKey
ALTER TABLE "CreativeTemplate" ADD CONSTRAINT "CreativeTemplate_referenceMediaId_fkey" FOREIGN KEY ("referenceMediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
