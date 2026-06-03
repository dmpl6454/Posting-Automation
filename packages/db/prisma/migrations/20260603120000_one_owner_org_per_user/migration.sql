-- One personal OWNER org per user (concurrency backstop for ensurePersonalOrg).
--
-- This is a PARTIAL UNIQUE INDEX: Prisma's schema language can't express the
-- `WHERE role = 'OWNER'` predicate, so it cannot live in schema.prisma and is
-- NOT picked up by `prisma db push` (the mechanism this repo uses in prod via
-- the migrate container). It must be applied by hand.
--
-- ORDERING — APPLY ONLY AFTER DEDUP:
-- Creating this index will FAIL if any user currently OWNs more than one org
-- (e.g. the duplicate 'Tabish' / 'Aditi' workspaces). Dedup those duplicate
-- OWNER orgs first, THEN create the index. ensurePersonalOrg's catch-and-reread
-- (P2002) already collapses the common same-user race WITHOUT this index, so it
-- is safe to ship the code now and add this index after data remediation.
--
-- Detect offenders before applying:
--   SELECT "userId", count(*) FROM "OrganizationMember"
--   WHERE role = 'OWNER' GROUP BY "userId" HAVING count(*) > 1;
--
-- Apply on prod (psql one-liner). NOTE: the DB role/db are both `postautomation`
-- (NOT `postgres` — that role does not exist on this server):
--   ssh posting-automation 'docker exec postautomation-postgres-1 psql -U postautomation postautomation -c "CREATE UNIQUE INDEX IF NOT EXISTS \"OrganizationMember_userId_owner_unique\" ON \"OrganizationMember\" (\"userId\") WHERE \"role\" = '\''OWNER'\'';"'

CREATE UNIQUE INDEX IF NOT EXISTS "OrganizationMember_userId_owner_unique"
  ON "OrganizationMember" ("userId")
  WHERE "role" = 'OWNER';
