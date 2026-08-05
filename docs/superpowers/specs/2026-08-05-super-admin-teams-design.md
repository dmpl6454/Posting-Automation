# Super-admin Teams — shared-channel workspaces

**Date:** 2026-08-05
**Status:** Approved (design)
**Branch:** `feat/super-admin-teams-2026-08-05`

## Problem

Three owner questions, answered against the code and live production data before designing:

1. **"Let super admin add two or more individuals to a team that shares all their channels."**
2. **"Two individuals signed in with Google and had access to everything — they should only have user-level access, right?"**
3. **"If I connected 60 channels from FB/IG account A, can I add more channels using account B?"**

Only (1) needs building. (2) is a real misconfiguration with a cause other than the one suspected. (3) already works.

## Findings that shaped the design

### Channels are org-owned, not user-owned

`Channel` carries `organizationId` and **no `userId`** ([schema.prisma:211-235](../../../packages/db/prisma/schema.prisma#L211-L235)),
unique on `@@unique([organizationId, platform, platformId])`. Access flows through
`orgProcedure`, which requires a real `OrganizationMember` row
([trpc.ts:168-215](../../../packages/api/src/trpc.ts#L168-L215)).

**Therefore the requested "team with pooled channels" is what an Organization already is.**
Two members of one org already share every channel, insight, and post. The gap is not a
data model — it is that no super-admin UI exists to put two people in one org, and each
Google signup silently receives a private personal org via `ensurePersonalOrg`.

### The ADMIN over-permissioning is a backfill artifact, not a Google-auth bug

`scripts/backfill-app-roles.ts` promoted **every** user created before `RBAC_ADMIN_CUTOFF`
to `appRole=ADMIN` ([backfill-app-roles.ts:38-42](../../../scripts/backfill-app-roles.ts#L38-L42)).

Live production count: **34 users are `appRole=ADMIN`.** Only `arman988ansari@gmail.com`
(created 2026-07-17) is a recent Google signup; the rest are grandfathered. Two caveats:

- `aditi@dashmani.com` has `isSuperAdmin=true`, which overrides `appRole` at every gate and
  **cannot** be fixed with the Access selector.
- Two junk rows exist: `abc@gmail.com` and a typo'd `purvamore.works@gamil.com` ("gamil").

Owner decision: **surface the list; the owner decides every role change in the UI.** This
spec changes no user's role.

### Second FB/IG account already works — no change

The OAuth callback does `channel.upsert` keyed on `(organizationId, platform, platformId)`
where `platformId` is the **Page ID**
([route.ts:239-289](../../../apps/web/app/api/oauth/callback/%5Bprovider%5D/route.ts#L239)).
Account B's Pages have different Page IDs, so they insert as new rows; account A's channels
are untouched. Each Page carries **its own Page access token**, independent of the
connecting user. No per-org channel cap exists in plan limits, and `BILLING_DISABLED=true`
on prod bypasses them regardless. Proven at scale — this account already runs 387 FB channels.

**Sole caveat:** if the same Page is administered by both A and B, the upsert overwrites that
channel's token with the most recent connector's Page token. Same channel, not a duplicate,
and harmless — either token posts to the same Page.

### Simultaneous posting by A and B is structurally safe

Verified for the owner's added requirement ("both must be able to post without any issues"):

- **Rate limits are keyed per-USER**, not per-org
  ([rate-limit.middleware.ts:25-29](../../../packages/api/src/middleware/rate-limit.middleware.ts#L25))
  — B's activity cannot throttle A.
- **Posts carry `createdById`** ([post.router.ts:271](../../../packages/api/src/routers/post.router.ts#L271))
  — attribution stays per-person, so publish-report emails still reach the actual creator.
- **The publish worker uses an atomic claim** (`updateMany` gated on
  `SCHEDULED/FAILED/DRAFT → PUBLISHING`) plus a `publishedId` short-circuit — concurrent
  jobs against the same target cannot double-post.

**Shared resource:** `enforcePlanLimit("postsPerMonth")` is per-org, so members draw from one
quota. Inert while `BILLING_DISABLED=true`; becomes real if billing is re-armed.

## Design

### Architecture

**A "team" is an existing Organization with more than one member.** No new model. No change
to `orgProcedure`. The build is a super-admin control panel over `OrganizationMember` rows,
plus role visibility.

This is deliberate: `orgProcedure` is the single gate preventing cross-org IDOR across ~40
models. The rejected "Team layer spanning orgs" alternative would have required widening that
gate and auditing every `organizationId` filter — high risk for no additional capability.

### Component 1 — `admin.teams` router

New file `packages/api/src/routers/admin/teams.router.ts`, registered in
`packages/api/src/routers/admin/index.ts`. Every procedure is `superAdminProcedure`,
matching the sibling admin routers.

| Procedure | Input | Behavior |
|---|---|---|
| `list` | `{ limit, cursor }` | Orgs with member count ≥ 2; member/channel/post counts. Paginated. |
| `getById` | `{ organizationId }` | Members (org role, appRole, isSuperAdmin, joined date) + channel counts by platform. |
| `searchUsers` | `{ query, organizationId }` | Type-ahead by email/name for the add dialog; excludes current members. |
| `addMember` | `{ organizationId, userId, role: MEMBER\|ADMIN = MEMBER }` | Creates the membership. Idempotent against `@@unique([userId, organizationId])`. Audit-logged. |
| `removeMember` | `{ organizationId, userId }` | Deletes the membership. Refuses to remove the last OWNER. Audit-logged. |
| `updateMemberRole` | `{ organizationId, userId, role: MEMBER\|ADMIN }` | MEMBER ⇄ ADMIN only. Never reads or writes OWNER. Audit-logged. |

### Component 2 — `/admin/teams` page

`apps/web/app/admin/teams/page.tsx`, following the existing `/admin/orgs` page structure,
plus a nav entry in `AdminSidebar`.

- **List view:** multi-member workspaces with member and channel counts.
- **Detail view:** members table showing **org role and appRole side by side**, with an
  inline warning when a member's `appRole=USER` would block admin-only features
  (Autopilot, RSS, Campaigns, Brand Outreach). Purely informational — no behavior change.
- **Add-member dialog:** email/name search, role defaulting to MEMBER.

### Component 3 — Users panel verification

Confirm the existing `/admin/users` Access selector surfaces all 34 ADMINs (filter/paginate
as needed) and displays `isSuperAdmin` distinctly from `appRole`, since a super-admin flag
cannot be corrected with that selector. **No role is changed by this work.**

### Data flow

```
super admin → addMember(organizationId: A's org, userId: B)
            → INSERT OrganizationMember(B, A's org, MEMBER)

B's next request → orgProcedure resolves A's org
                 → membership found ✓
                 → channel.list returns all of A's channels
```

Nothing else moves. A's channels, posts, insights, and analytics stay in place.

### Guardrails

- **Last-OWNER protection** — `removeMember` and `updateMemberRole` refuse to leave an org
  without an OWNER.
- **Never grant OWNER.** The migration
  `packages/db/prisma/migrations/20260603120000_one_owner_org_per_user/` adds a partial unique
  index on `OrganizationMember(userId) WHERE role='OWNER'`. Prisma cannot express a partial
  unique, so `db push` does not apply it — it is applied by hand, and its own comment warns it
  **fails if any user already owns more than one org** (it names the duplicate Tabish/Aditi
  workspaces; live data confirms `aditi@dashmani.com` holds 2 memberships). Because
  `addMember` defaults to MEMBER and the role enum excludes OWNER, **this feature cannot
  create new offenders** — the pending remediation stays exactly as hard as it is today.
- **Audit trail** — every mutation writes an `AuditLog`, mirroring `admin.users.setAppRole`.
- **Removal is non-destructive** — the user loses access; no channel, post, or analytics row
  is deleted.

### Error handling

- Unknown `organizationId` / `userId` → `NOT_FOUND`.
- Duplicate `addMember` → succeeds idempotently (returns the existing membership), so a
  double-click cannot 500.
- Last-OWNER violation → `BAD_REQUEST` with an actionable message.
- Non-super-admin caller → `FORBIDDEN` via `superAdminProcedure`.

## Out of scope (deliberate)

- **Channel migration between orgs.** Moving a `Channel` orphans its `PostTarget`s from their
  parent `Post` (which carries its own `organizationId`), producing history invisible to both
  orgs and a latent cross-org leak. A `Post` targeting channels in two orgs cannot be cleanly
  assigned to either. Making A's existing org the team org avoids the problem instead of
  solving it. **Owner-approved.**
- **FB/IG multi-account connect.** Already works; no change.
- **The publish pipeline, OAuth callback, and `orgProcedure`.** Untouched, per the standing
  "the posting process works — do NOT break it" constraint.
- **Any user's role change.** The owner decides each one in the UI.

## Testing

New `packages/api/src/__tests__/admin-teams.test.ts`, following the existing admin-router
test patterns:

1. **Super-admin gating** — a plain USER and an `appRole=ADMIN` non-super-admin both get
   `FORBIDDEN` on every procedure.
2. **`addMember` idempotency** — calling twice yields one membership, no throw.
3. **Last-OWNER refusal** — `removeMember` on the sole OWNER throws; `updateMemberRole`
   cannot demote it.
4. **Role enum** — OWNER is not an accepted input value.
5. **Pooling (real Postgres)** — after `addMember`, `channel.list` called as the new member
   returns the original member's channels.
6. **Isolation** — `getById` for an unrelated org still requires super admin; no cross-org
   data leaks into the members list.

Existing suites that must stay green: `app-role-gating.test.ts` (29 tests — locks which
routers are admin-gated) and the org-isolation tests.

## Known caveats stated to the owner

1. **Shared monthly post quota** — `postsPerMonth` is per-org, so team members draw from one
   pool. Inert under `BILLING_DISABLED=true`; real if billing is re-armed.
2. **B keeps their own workspace** — B's own channels remain in B's personal org. To pool
   them, B reconnects them while switched to the team workspace (a normal OAuth connect, no
   migration).
