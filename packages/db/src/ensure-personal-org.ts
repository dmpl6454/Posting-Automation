import { Prisma } from "@prisma/client";
import type { Organization, PrismaClient } from "@prisma/client";
import { getPreauthOrgData } from "./preauth";

/**
 * Idempotent personal-org provisioning.
 * ─────────────────────────────────────────────────────────────────────────────
 * S2: this is the single source of truth for "every user has exactly one
 * personal org". Previously four call sites (auth events.createUser, the
 * credentials register route, the orgProcedure auto-create branch, and
 * org.router `current`) each ran their own inline `organization.create`. With
 * no userId guard between them, a person who signed up via OAuth and then
 * registered with credentials (same email) ended up with TWO personal orgs —
 * the root cause of channels landing in the "wrong" org.
 *
 * Concurrency guarantee (at most one OWNER org per user):
 *  - DB level: a PARTIAL UNIQUE INDEX on OrganizationMember(userId) WHERE
 *    role = 'OWNER' makes a duplicate OWNER membership impossible. Prisma's
 *    schema language can't express a partial unique index, so it lives in a
 *    raw-SQL migration (packages/db/prisma/migrations/*_one_owner_org_per_user)
 *    and must be applied manually on prod (see that file's header for the
 *    exact psql one-liner). The index can only be created AFTER any existing
 *    duplicate OWNER orgs have been deduped.
 *  - Code level: the create is wrapped in a try/catch for Prisma's
 *    unique-constraint violation (P2002). Under a race — e.g. OAuth
 *    events.createUser firing at the same time as the first orgProcedure/me
 *    call — the loser of the create catches P2002, re-reads the OWNER org the
 *    winner just inserted, and returns that. This catch-and-reread works
 *    whether the violated constraint is the new partial index OR the existing
 *    @@unique([userId, organizationId]) on the members.create, so it is SAFE
 *    TO SHIP BEFORE the partial index exists: it still collapses the common
 *    same-user race. The partial index is the durable belt-and-braces backstop
 *    once dedup has run.
 *
 * Other invariants:
 *  - Guards on userId (NOT org name): if the user already OWNs an org we return
 *    it instead of creating a duplicate.
 *  - Deterministic selection (orderBy createdAt asc) so concurrent callers and
 *    the orgProcedure/me/current fallbacks all converge on the SAME org.
 *  - Preserves the existing slug pattern and pre-authorised ENTERPRISE trial.
 */
export async function ensurePersonalOrg(
  prisma: PrismaClient,
  userId: string,
  email: string
): Promise<Organization> {
  // Read-then-create lives in a transaction so the existence check + create are
  // atomic against a single caller's view. Under a true race two transactions
  // can still both pass the existence check and both attempt the create; the DB
  // unique constraint then rejects the loser, which we recover from below.
  const findExistingOwnerOrg = async (
    db: Pick<PrismaClient, "organizationMember">
  ): Promise<Organization | null> => {
    const existing = await db.organizationMember.findFirst({
      where: { userId, role: "OWNER" },
      orderBy: { createdAt: "asc" },
      include: { organization: true },
    });
    return existing?.organization ?? null;
  };

  try {
    return await prisma.$transaction(async (tx) => {
      // Guard on userId, not name: an existing OWNER membership means this
      // person already has a personal org — return it rather than minting a
      // duplicate. Deterministic orderBy keeps this identical to the
      // orgProcedure/me/current fallbacks so everyone resolves to the same org.
      const existing = await findExistingOwnerOrg(tx);
      if (existing) return existing;

      const slug = (email.split("@")[0] ?? email)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");
      const displayName = slug || "user";

      // Keep slug uniqueness via the org-<id8>-<timestamp> shape used elsewhere.
      const preauthData = getPreauthOrgData(email);
      return tx.organization.create({
        data: {
          name: `${displayName}'s Workspace`,
          slug: `org-${userId.slice(0, 8)}-${Date.now().toString(36)}`,
          ...(preauthData ?? {}),
          members: {
            create: {
              userId,
              role: "OWNER",
            },
          },
        },
      });
    });
  } catch (err) {
    // A concurrent caller won the race and created the OWNER org/membership
    // first. The DB rejected our create with a unique-constraint violation
    // (the partial OWNER index, once applied, or @@unique([userId,
    // organizationId])). Re-read the now-existing OWNER org and return the
    // winner's row instead of surfacing the error.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await findExistingOwnerOrg(prisma);
      if (winner) return winner;
    }
    throw err;
  }
}
