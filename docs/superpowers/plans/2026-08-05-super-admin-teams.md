# Super-admin Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give super admin a UI to add two or more individuals to one Organization so they share all its channels, with both org-role and app-role visibility.

**Architecture:** A "team" is an existing Organization with >1 member. `Channel` is already org-scoped (`organizationId`, no `userId`), so pooling requires no schema change and no change to `orgProcedure`. The build is a new `admin.teams` tRPC router over `OrganizationMember` rows plus an `/admin/teams` page. Nothing in the publish pipeline, OAuth callback, or `orgProcedure` is touched.

**Tech Stack:** tRPC v11 + zod, Prisma (Postgres), Next.js App Router, Vitest, shadcn/ui, TanStack Query.

**Design spec:** [docs/superpowers/specs/2026-08-05-super-admin-teams-design.md](../specs/2026-08-05-super-admin-teams-design.md)

**Branch:** `feat/super-admin-teams-2026-08-05` (already created)

---

## Background the implementer needs

**Read these before starting:**

- `packages/api/src/routers/admin/orgs.router.ts` — the exact router pattern to copy (superAdminProcedure, cursor pagination, `createAuditLog(...).catch(() => {})`).
- `packages/api/src/routers/admin/users.router.ts:121-140` — `setAppRole`, the audit-log shape.
- `apps/web/app/admin/orgs/page.tsx` — the page pattern (DataTable, useInfiniteQuery, humanizeError, useToast).
- `packages/api/src/__tests__/app-role-gating.test.ts` — the test style, incl. the hoisted `vi.mock("@postautomation/db")`.

**Key domain facts (do not re-derive):**

1. `Channel` model: `@@unique([organizationId, platform, platformId])`, **no `userId`**. Channels belong to an org.
2. `OrganizationMember`: `@@unique([userId, organizationId])`, `role: MemberRole @default(MEMBER)`.
3. `MemberRole` enum = `OWNER | ADMIN | MEMBER`. **VIEWER was removed — never reintroduce it.**
4. **Never grant OWNER via this feature.** A pending partial unique index (`packages/db/prisma/migrations/20260603120000_one_owner_org_per_user/`) enforces one OWNER org per user and *fails to apply* if any user owns two. `addMember`'s role enum must exclude OWNER.
5. `AUDIT_ACTIONS` lives in `packages/api/src/lib/audit.ts`. Existing team actions: `MEMBER_INVITED`, `MEMBER_REMOVED`, `MEMBER_ROLE_CHANGED`. We add three `ADMIN_TEAM_*` actions.
6. Web imports use `~/` (apps/web has no `src` dir). **Never `@/`.**
7. `appRole` (app-level: USER/ADMIN) is a **separate gate** from org `MemberRole`. A member can be org-ADMIN yet blocked from Autopilot/RSS/Campaigns because their `appRole` is USER. The UI must show both.

**Commands:**

```bash
pnpm --filter @postautomation/api test                                  # api tests
pnpm --filter @postautomation/api exec tsc --noEmit                     # api types
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build           # web build (REQUIRED before merge)
```

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `packages/api/src/lib/team-membership.ts` | Pure, testable guard helpers: `assertNotLastOwner`, `TEAM_ASSIGNABLE_ROLES`. No Prisma, no I/O. |
| **Create** `packages/api/src/routers/admin/teams.router.ts` | 6 superAdminProcedure procedures over OrganizationMember. |
| **Modify** `packages/api/src/routers/admin/index.ts` | Register `teams: adminTeamsRouter`. |
| **Modify** `packages/api/src/lib/audit.ts` | Add 3 `ADMIN_TEAM_*` audit actions. |
| **Create** `packages/api/src/__tests__/admin-teams.test.ts` | Unit tests for the pure guards + wiring lock asserting every procedure is superAdminProcedure. |
| **Create** `apps/web/app/admin/teams/page.tsx` | List of multi-member workspaces. |
| **Create** `apps/web/app/admin/teams/[id]/page.tsx` | Team detail: members table (org role + appRole + mismatch warning), add/remove/role controls. |
| **Modify** `apps/web/components/admin/AdminSidebar.tsx` | Add the "Teams" nav entry. |
| **Modify** `apps/web/app/admin/users/page.tsx` | Show `isSuperAdmin` distinctly (it overrides appRole and the Access selector cannot fix it). |

Splitting the pure guards into `team-membership.ts` keeps the last-OWNER rule unit-testable without a tRPC/Prisma harness — the same discipline as `publish-stagger.ts` and `group-stats.ts`.

---

## Task 1: Pure membership guards

**Files:**
- Create: `packages/api/src/lib/team-membership.ts`
- Test: `packages/api/src/__tests__/admin-teams.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/__tests__/admin-teams.test.ts`:

```ts
/**
 * Super-admin Teams (2026-08-05).
 *
 * A "team" is an Organization with >1 member — Channel is already org-scoped,
 * so pooling needs no schema change. These tests lock the two things that could
 * cause real damage:
 *   1. The last-OWNER guard (an ownerless org is unrecoverable via this UI).
 *   2. OWNER is never assignable (a second OWNER org per user would break the
 *      pending partial unique index in
 *      migrations/20260603120000_one_owner_org_per_user/).
 */
import { describe, it, expect } from "vitest";
import {
  TEAM_ASSIGNABLE_ROLES,
  assertNotLastOwner,
  type MembershipLike,
} from "../lib/team-membership";

const owner = (userId: string): MembershipLike => ({ userId, role: "OWNER" });
const member = (userId: string): MembershipLike => ({ userId, role: "MEMBER" });

describe("TEAM_ASSIGNABLE_ROLES", () => {
  it("offers exactly MEMBER and ADMIN", () => {
    expect(TEAM_ASSIGNABLE_ROLES).toEqual(["MEMBER", "ADMIN"]);
  });

  it("never includes OWNER (pending one-OWNER-org-per-user unique index)", () => {
    expect(TEAM_ASSIGNABLE_ROLES).not.toContain("OWNER");
  });

  it("never includes the removed VIEWER role", () => {
    expect(TEAM_ASSIGNABLE_ROLES).not.toContain("VIEWER");
  });
});

describe("assertNotLastOwner", () => {
  it("throws when removing the only OWNER", () => {
    expect(() => assertNotLastOwner([owner("a"), member("b")], "a")).toThrow(
      /last owner/i
    );
  });

  it("allows removing a MEMBER while an OWNER remains", () => {
    expect(() => assertNotLastOwner([owner("a"), member("b")], "b")).not.toThrow();
  });

  it("allows removing one OWNER when another OWNER remains", () => {
    expect(() =>
      assertNotLastOwner([owner("a"), owner("b"), member("c")], "a")
    ).not.toThrow();
  });

  it("does not throw for a user who is not a member (caller handles NOT_FOUND)", () => {
    expect(() => assertNotLastOwner([owner("a")], "zz")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/api test admin-teams`
Expected: FAIL — `Cannot find module '../lib/team-membership'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/api/src/lib/team-membership.ts`:

```ts
/**
 * Pure guards for super-admin team membership management.
 *
 * Kept free of Prisma/tRPC so the rules that matter are unit-testable without a
 * DB harness (same discipline as publish-stagger.ts / group-stats.ts).
 */
import { TRPCError } from "@trpc/server";

/**
 * Roles a super admin may assign when adding/updating a team member.
 *
 * OWNER is deliberately EXCLUDED. A pending partial unique index
 * (packages/db/prisma/migrations/20260603120000_one_owner_org_per_user/) enforces
 * one OWNER org per user and FAILS TO APPLY if any user owns two — so granting a
 * second OWNER here would create a new offender and block that remediation.
 * Ownership transfer stays in the org-scoped team router.
 */
export const TEAM_ASSIGNABLE_ROLES = ["MEMBER", "ADMIN"] as const;

export type TeamAssignableRole = (typeof TEAM_ASSIGNABLE_ROLES)[number];

/** Minimal shape needed by the guards — matches an OrganizationMember row. */
export type MembershipLike = { userId: string; role: string };

/**
 * Refuse an operation that would leave the org with no OWNER.
 *
 * An ownerless org cannot be repaired through this UI (OWNER is not assignable),
 * so this must be checked BEFORE any delete/update. A userId that is not a
 * member is a no-op here — the caller surfaces NOT_FOUND.
 */
export function assertNotLastOwner(
  members: MembershipLike[],
  targetUserId: string
): void {
  const target = members.find((m) => m.userId === targetUserId);
  if (!target || target.role !== "OWNER") return;

  const remainingOwners = members.filter(
    (m) => m.role === "OWNER" && m.userId !== targetUserId
  ).length;

  if (remainingOwners === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Cannot remove or demote the last owner of a workspace. Transfer ownership first.",
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/api test admin-teams`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/team-membership.ts packages/api/src/__tests__/admin-teams.test.ts
git commit -m "feat(api): pure guards for super-admin team membership

assertNotLastOwner prevents an unrecoverable ownerless org.
TEAM_ASSIGNABLE_ROLES excludes OWNER so this feature cannot create
new offenders for the pending one-OWNER-org-per-user unique index.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Audit actions

**Files:**
- Modify: `packages/api/src/lib/audit.ts` (the `AUDIT_ACTIONS` object, after `ADMIN_ORG_DELETED`)

- [ ] **Step 1: Add the three actions**

In `packages/api/src/lib/audit.ts`, immediately after the line `ADMIN_ORG_DELETED: "admin.org.deleted",`, insert:

```ts
  ADMIN_TEAM_MEMBER_ADDED: "admin.team.member_added",
  ADMIN_TEAM_MEMBER_REMOVED: "admin.team.member_removed",
  ADMIN_TEAM_MEMBER_ROLE_CHANGED: "admin.team.member_role_changed",
```

- [ ] **Step 2: Verify types compile**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: exit 0, no output

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/lib/audit.ts
git commit -m "feat(api): audit actions for super-admin team membership changes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The `admin.teams` router

**Files:**
- Create: `packages/api/src/routers/admin/teams.router.ts`
- Modify: `packages/api/src/routers/admin/index.ts`
- Test: `packages/api/src/__tests__/admin-teams.test.ts` (append)

- [ ] **Step 1: Write the failing wiring-lock test**

Append to `packages/api/src/__tests__/admin-teams.test.ts`:

```ts
// ── Wiring lock ──────────────────────────────────────────────────────────────
// Reads the router source and asserts every procedure is superAdminProcedure.
// A refactor that swaps one to orgProcedure/protectedProcedure would expose
// cross-org membership writes to ordinary users — this fails first.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const teamsSrc = readFileSync(
  join(__dirname, "..", "routers", "admin", "teams.router.ts"),
  "utf8"
);

describe("admin.teams router wiring", () => {
  const PROCEDURES = [
    "list",
    "getById",
    "searchUsers",
    "addMember",
    "removeMember",
    "updateMemberRole",
  ];

  it("defines all six procedures", () => {
    for (const p of PROCEDURES) {
      expect(teamsSrc).toMatch(new RegExp(`\\b${p}:\\s*superAdminProcedure`));
    }
  });

  it("uses ONLY superAdminProcedure — no weaker procedure leaks in", () => {
    expect(teamsSrc).not.toMatch(/\borgProcedure\b/);
    expect(teamsSrc).not.toMatch(/\bprotectedProcedure\b/);
    expect(teamsSrc).not.toMatch(/\bpublicProcedure\b/);
    expect(teamsSrc).not.toMatch(/\badminOrgProcedure\b/);
  });

  it("never writes role OWNER", () => {
    expect(teamsSrc).not.toMatch(/role:\s*"OWNER"/);
  });

  it("guards mutations with assertNotLastOwner", () => {
    expect(teamsSrc).toMatch(/assertNotLastOwner/);
  });

  it("is registered on the admin router", () => {
    const indexSrc = readFileSync(
      join(__dirname, "..", "routers", "admin", "index.ts"),
      "utf8"
    );
    expect(indexSrc).toMatch(/teams:\s*adminTeamsRouter/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/api test admin-teams`
Expected: FAIL — `ENOENT ... teams.router.ts`

- [ ] **Step 3: Write the router**

Create `packages/api/src/routers/admin/teams.router.ts`:

```ts
/**
 * Super-admin team management (2026-08-05).
 *
 * A "team" IS an Organization with more than one member. Channel is already
 * org-scoped (organizationId, no userId), so adding a membership row pools every
 * channel, insight and post automatically — no schema change, and orgProcedure
 * (the single gate preventing cross-org IDOR) is untouched.
 *
 * Every procedure is superAdminProcedure: these read and write membership across
 * ALL organizations.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import {
  TEAM_ASSIGNABLE_ROLES,
  assertNotLastOwner,
} from "../../lib/team-membership";

const assignableRole = z.enum(TEAM_ASSIGNABLE_ROLES);

/** Load an org's memberships for the guards, or 404. */
async function loadMembers(
  prisma: any,
  organizationId: string
): Promise<{ userId: string; role: string }[]> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, members: { select: { userId: true, role: true } } },
  });
  if (!org) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
  }
  return org.members;
}

export const adminTeamsRouter = createRouter({
  /**
   * Workspaces that are already teams (>1 member). `onlyTeams: false` lists every
   * workspace, so a super admin can turn a single-member workspace INTO a team.
   */
  list: superAdminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
        search: z.string().optional(),
        onlyTeams: z.boolean().default(true),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor, search, onlyTeams } = input;

      const where: any = {};
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { slug: { contains: search, mode: "insensitive" } },
          {
            members: {
              some: { user: { email: { contains: search, mode: "insensitive" } } },
            },
          },
        ];
      }

      const items = await ctx.prisma.organization.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          plan: true,
          createdAt: true,
          _count: { select: { members: true, channels: true, posts: true } },
        },
        orderBy: [{ createdAt: "desc" }],
      });

      let nextCursor: string | undefined;
      if (items.length > limit) {
        nextCursor = items.pop()!.id;
      }

      // Filter AFTER pagination: Prisma cannot filter on a relation _count.
      // nextCursor still walks every row, so no page is skipped.
      const filtered = onlyTeams
        ? items.filter((o) => o._count.members > 1)
        : items;

      return { items: filtered, nextCursor };
    }),

  /** One workspace: members with BOTH roles, plus channel counts by platform. */
  getById: superAdminProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ ctx, input }) => {
      const org = await ctx.prisma.organization.findUnique({
        where: { id: input.organizationId },
        select: {
          id: true,
          name: true,
          slug: true,
          plan: true,
          createdAt: true,
          members: {
            select: {
              id: true,
              role: true,
              createdAt: true,
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                  appRole: true,
                  isSuperAdmin: true,
                },
              },
            },
            orderBy: [{ role: "asc" }, { createdAt: "asc" }],
          },
          _count: { select: { channels: true, posts: true } },
        },
      });
      if (!org) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      }

      const grouped = await ctx.prisma.channel.groupBy({
        by: ["platform"],
        where: { organizationId: input.organizationId, isActive: true },
        _count: { _all: true },
      });

      return {
        ...org,
        channelsByPlatform: grouped
          .map((g) => ({ platform: g.platform, count: g._count._all }))
          .sort((a, b) => b.count - a.count),
      };
    }),

  /** Type-ahead for the add-member dialog. Excludes existing members. */
  searchUsers: superAdminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        query: z.string().min(1).max(200),
        limit: z.number().min(1).max(25).default(10),
      })
    )
    .query(async ({ ctx, input }) => {
      const q = input.query.trim();
      if (!q) return [];

      return ctx.prisma.user.findMany({
        where: {
          isBanned: false,
          members: { none: { organizationId: input.organizationId } },
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          appRole: true,
          isSuperAdmin: true,
        },
        take: input.limit,
        orderBy: { createdAt: "desc" },
      });
    }),

  /**
   * Add a user to a workspace. Idempotent against
   * @@unique([userId, organizationId]) so a double-click cannot 500.
   */
  addMember: superAdminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        userId: z.string(),
        role: assignableRole.default("MEMBER"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await loadMembers(ctx.prisma, input.organizationId);

      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true },
      });
      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      const existing = await ctx.prisma.organizationMember.findUnique({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: input.organizationId,
          },
        },
      });
      if (existing) return { membership: existing, alreadyMember: true };

      const membership = await ctx.prisma.organizationMember.create({
        data: {
          userId: input.userId,
          organizationId: input.organizationId,
          role: input.role,
        },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_TEAM_MEMBER_ADDED,
        entityType: "OrganizationMember",
        entityId: membership.id,
        metadata: { addedUserId: input.userId, email: user.email, role: input.role },
      }).catch(() => {});

      return { membership, alreadyMember: false };
    }),

  /** Remove a member. Non-destructive: only the membership row is deleted. */
  removeMember: superAdminProcedure
    .input(z.object({ organizationId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const members = await loadMembers(ctx.prisma, input.organizationId);

      if (!members.some((m) => m.userId === input.userId)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That user is not a member of this workspace",
        });
      }

      assertNotLastOwner(members, input.userId);

      await ctx.prisma.organizationMember.delete({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: input.organizationId,
          },
        },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_TEAM_MEMBER_REMOVED,
        entityType: "OrganizationMember",
        entityId: `${input.organizationId}:${input.userId}`,
        metadata: { removedUserId: input.userId },
      }).catch(() => {});

      return { success: true };
    }),

  /** MEMBER <-> ADMIN only. OWNER is never read or written here. */
  updateMemberRole: superAdminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        userId: z.string(),
        role: assignableRole,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const members = await loadMembers(ctx.prisma, input.organizationId);

      if (!members.some((m) => m.userId === input.userId)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That user is not a member of this workspace",
        });
      }

      // Demoting the sole OWNER would leave the org unrecoverable (OWNER is not
      // assignable through this router).
      assertNotLastOwner(members, input.userId);

      const membership = await ctx.prisma.organizationMember.update({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: input.organizationId,
          },
        },
        data: { role: input.role },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_TEAM_MEMBER_ROLE_CHANGED,
        entityType: "OrganizationMember",
        entityId: membership.id,
        metadata: { targetUserId: input.userId, newRole: input.role },
      }).catch(() => {});

      return membership;
    }),
});
```

- [ ] **Step 4: Register the router**

In `packages/api/src/routers/admin/index.ts`, add the import after the `adminAuditRouter` import:

```ts
import { adminTeamsRouter } from "./teams.router";
```

and add this entry to the `createRouter({...})` object, after `orgs: adminOrgsRouter,`:

```ts
  teams: adminTeamsRouter,
```

- [ ] **Step 5: Run tests + types**

Run: `pnpm --filter @postautomation/api test admin-teams`
Expected: PASS — 12 tests (7 from Task 1 + 5 wiring)

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routers/admin/teams.router.ts packages/api/src/routers/admin/index.ts packages/api/src/__tests__/admin-teams.test.ts
git commit -m "feat(api): admin.teams router — super-admin shared-channel workspaces

Six superAdminProcedure procedures over OrganizationMember. Adding a
membership pools every channel automatically because Channel is org-scoped;
orgProcedure and the publish pipeline are untouched.

Guards: last-OWNER refusal, OWNER never assignable, idempotent addMember.
Wiring lock test asserts no weaker procedure can leak in.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Teams list page + sidebar nav

**Files:**
- Create: `apps/web/app/admin/teams/page.tsx`
- Modify: `apps/web/components/admin/AdminSidebar.tsx`

- [ ] **Step 1: Add the sidebar entry**

In `apps/web/components/admin/AdminSidebar.tsx`:

Add `UsersRound` to the `lucide-react` import list (keep the existing names).

Then insert into `navItems`, immediately after the `Organizations` entry:

```ts
  { label: "Teams", href: "/admin/teams", icon: UsersRound },
```

- [ ] **Step 2: Create the list page**

Create `apps/web/app/admin/teams/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { Users, Radio } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import { useDebounce } from "~/hooks/use-debounce";

type TeamRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  createdAt: Date;
  _count: { members: number; channels: number; posts: number };
};

export default function AdminTeamsPage() {
  const [search, setSearch] = useState("");
  const [onlyTeams, setOnlyTeams] = useState(true);
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage } =
    trpc.admin.teams.list.useInfiniteQuery(
      { search: debouncedSearch || undefined, onlyTeams, limit: 50 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const items = (data?.pages.flatMap((p) => p.items) ?? []) as TeamRow[];

  const columns: Column<TeamRow>[] = [
    {
      header: "Workspace",
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">{row.slug}</p>
        </div>
      ),
    },
    {
      header: "Members",
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          {row._count.members}
        </span>
      ),
    },
    {
      header: "Shared channels",
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <Radio className="h-3.5 w-3.5 text-muted-foreground" />
          {row._count.channels}
        </span>
      ),
    },
    { header: "Posts", cell: (row) => row._count.posts },
    { header: "Plan", cell: (row) => <Badge variant="outline">{row.plan}</Badge> },
    {
      header: "",
      cell: (row) => (
        <Button asChild variant="outline" size="sm">
          <Link href={`/admin/teams/${row.id}`}>Manage</Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Teams</h1>
        <p className="text-sm text-muted-foreground">
          A team is a workspace with more than one member. Every member shares all
          of that workspace&apos;s channels, insights and posts.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by workspace or member email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Button
          variant={onlyTeams ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyTeams((v) => !v)}
        >
          {onlyTeams ? "Teams only" : "All workspaces"}
        </Button>
      </div>

      {onlyTeams && (
        <p className="text-xs text-muted-foreground">
          Showing workspaces with 2+ members. Switch to “All workspaces” to turn a
          single-member workspace into a team.
        </p>
      )}

      <DataTable
        columns={columns}
        data={items}
        isLoading={isLoading}
        emptyMessage={
          onlyTeams
            ? "No multi-member workspaces yet. Switch to “All workspaces” to create one."
            : "No workspaces found."
        }
      />

      {hasNextPage && (
        <Button
          variant="outline"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify the DataTable prop names**

`DataTable` is shared. Before running the build, open `apps/web/components/admin/DataTable.tsx` and confirm the prop names used above (`columns`, `data`, `isLoading`, `emptyMessage`) match its actual interface. If they differ, adopt the real names — do not change `DataTable` itself.

- [ ] **Step 4: Build**

Run: `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`
Expected: exit 0, `/admin/teams` in the route list

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/admin/teams/page.tsx apps/web/components/admin/AdminSidebar.tsx
git commit -m "feat(web): /admin/teams list — multi-member workspaces

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Team detail page — members, both roles, add/remove

**Files:**
- Create: `apps/web/app/admin/teams/[id]/page.tsx`

- [ ] **Step 1: Create the detail page**

Create `apps/web/app/admin/teams/[id]/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ShieldAlert, Trash2, UserPlus } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ConfirmDialog } from "~/components/admin/ConfirmDialog";
import { useDebounce } from "~/hooks/use-debounce";
import { useToast } from "~/hooks/use-toast";

const ASSIGNABLE = ["MEMBER", "ADMIN"] as const;

export default function AdminTeamDetailPage() {
  const params = useParams<{ id: string }>();
  const organizationId = params.id;
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [pendingRemove, setPendingRemove] = useState<{
    userId: string;
    email: string;
  } | null>(null);

  const teamQuery = trpc.admin.teams.getById.useQuery({ organizationId });

  const candidates = trpc.admin.teams.searchUsers.useQuery(
    { organizationId, query: debouncedSearch },
    { enabled: debouncedSearch.trim().length > 0 }
  );

  const onError = (err: unknown) =>
    toast({
      title: "Error",
      description: humanizeError(err),
      variant: "destructive",
    });

  const refresh = () => {
    teamQuery.refetch();
    candidates.refetch();
  };

  const addMember = trpc.admin.teams.addMember.useMutation({
    onSuccess: (res) => {
      refresh();
      setSearch("");
      toast({
        title: res.alreadyMember ? "Already a member" : "Member added",
        description: res.alreadyMember
          ? "That user was already in this workspace."
          : "They now share every channel in this workspace.",
      });
    },
    onError,
  });

  const removeMember = trpc.admin.teams.removeMember.useMutation({
    onSuccess: () => {
      refresh();
      setPendingRemove(null);
      toast({ title: "Member removed" });
    },
    onError: (err) => {
      setPendingRemove(null);
      onError(err);
    },
  });

  const updateRole = trpc.admin.teams.updateMemberRole.useMutation({
    onSuccess: () => {
      refresh();
      toast({ title: "Role updated" });
    },
    onError,
  });

  const team = teamQuery.data;
  const members = team?.members ?? [];
  const restrictedCount = members.filter(
    (m) => m.user.appRole !== "ADMIN" && !m.user.isSuperAdmin
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
          <Link href="/admin/teams">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            All teams
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">
          {teamQuery.isLoading ? "Loading…" : team?.name ?? "Workspace"}
        </h1>
        {team && (
          <p className="text-sm text-muted-foreground">
            {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
            {team._count.channels} shared channel
            {team._count.channels === 1 ? "" : "s"} · {team._count.posts} post
            {team._count.posts === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {/* Add member */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a member</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Everyone added here immediately shares all {team?._count.channels ?? 0}{" "}
            channels in this workspace — they can post to them and see their
            insights. Nothing is moved or copied.
          </p>
          <Input
            placeholder="Search users by email or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
          {debouncedSearch.trim().length > 0 && (
            <div className="divide-y rounded-md border">
              {candidates.isLoading && (
                <p className="p-3 text-sm text-muted-foreground">Searching…</p>
              )}
              {!candidates.isLoading && (candidates.data?.length ?? 0) === 0 && (
                <p className="p-3 text-sm text-muted-foreground">
                  No matching users who aren&apos;t already members.
                </p>
              )}
              {candidates.data?.map((u) => (
                <div
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-2 p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {u.name ?? u.email}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {u.email} · app role{" "}
                      {u.isSuperAdmin ? "super admin" : u.appRole.toLowerCase()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={addMember.isPending}
                    onClick={() =>
                      addMember.mutate({
                        organizationId,
                        userId: u.id,
                        role: "MEMBER",
                      })
                    }
                  >
                    <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                    {addMember.isPending &&
                    addMember.variables?.userId === u.id
                      ? "Adding…"
                      : "Add as member"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {restrictedCount > 0 && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p>
                {restrictedCount} member
                {restrictedCount === 1 ? " has" : "s have"} the app role{" "}
                <strong>user</strong>. They can post and view insights for every
                shared channel, but admin-only features (Autopilot, RSS,
                Campaigns, Brand Outreach) stay blocked regardless of their
                workspace role. Change app roles in{" "}
                <Link href="/admin/users" className="underline">
                  Users
                </Link>
                .
              </p>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Member</th>
                  <th className="py-2 pr-3 font-medium">Workspace role</th>
                  <th className="py-2 pr-3 font-medium">App role</th>
                  <th className="py-2 pr-3 font-medium">Joined</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((m) => {
                  const isOwner = m.role === "OWNER";
                  const busy =
                    updateRole.isPending &&
                    updateRole.variables?.userId === m.user.id;
                  return (
                    <tr key={m.id}>
                      <td className="py-2.5 pr-3">
                        <p className="font-medium">{m.user.name ?? m.user.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {m.user.email}
                        </p>
                      </td>
                      <td className="py-2.5 pr-3">
                        {isOwner ? (
                          <Badge>owner</Badge>
                        ) : (
                          <Select
                            value={m.role}
                            disabled={busy}
                            onValueChange={(role) =>
                              updateRole.mutate({
                                organizationId,
                                userId: m.user.id,
                                role: role as (typeof ASSIGNABLE)[number],
                              })
                            }
                          >
                            <SelectTrigger className="h-8 w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ASSIGNABLE.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {r.toLowerCase()}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        {m.user.isSuperAdmin ? (
                          <Badge variant="destructive">super admin</Badge>
                        ) : m.user.appRole === "ADMIN" ? (
                          <Badge variant="outline">admin</Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-amber-500/50 text-amber-700"
                          >
                            user
                          </Badge>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                        {new Date(m.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-2.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isOwner || removeMember.isPending}
                          title={
                            isOwner
                              ? "The workspace owner cannot be removed here"
                              : "Remove from workspace"
                          }
                          onClick={() =>
                            setPendingRemove({
                              userId: m.user.id,
                              email: m.user.email,
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Shared channels */}
      {team && team.channelsByPlatform.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Shared channels ({team._count.channels})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {team.channelsByPlatform.map((p) => (
              <Badge key={p.platform} variant="outline">
                {p.platform.toLowerCase()} · {p.count}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title="Remove member from workspace?"
        description={`${pendingRemove?.email ?? "This user"} will immediately lose access to every channel, post and insight in this workspace. Nothing is deleted — you can add them back at any time.`}
        confirmLabel="Remove member"
        onConfirm={() =>
          pendingRemove &&
          removeMember.mutate({ organizationId, userId: pendingRemove.userId })
        }
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify the ConfirmDialog prop names**

Open `apps/web/components/admin/ConfirmDialog.tsx` and confirm the props used above (`open`, `onOpenChange`, `title`, `description`, `confirmLabel`, `onConfirm`) match its interface. If they differ, adopt the real names — do not modify `ConfirmDialog`.

- [ ] **Step 3: Build**

Run: `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`
Expected: exit 0, `/admin/teams/[id]` in the route list

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/admin/teams/[id]/page.tsx"
git commit -m "feat(web): team detail — members with org role + app role, add/remove

Shows BOTH gates side by side and warns when a member's appRole=USER
blocks admin features regardless of workspace role. OWNER row is
read-only (ownership transfer is not exposed here).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Surface `isSuperAdmin` in the Users panel

**Why:** the owner chose "show me the list, I'll decide in the UI" for the 34 `appRole=ADMIN` users. The existing Access selector already works, but a user with `isSuperAdmin=true` (e.g. `aditi@dashmani.com`) **overrides `appRole` at every gate** and the selector cannot fix it. Without a visible signal, demoting them looks like it worked when it did not.

**Files:**
- Modify: `apps/web/app/admin/users/page.tsx`

- [ ] **Step 1: Read the current Role/Access columns**

Open `apps/web/app/admin/users/page.tsx` and read the row type plus the `Role` and `Access` column definitions (around lines 26 and 110-140). Confirm whether `isSuperAdmin` is already on the row type and whether `admin.users.list` selects it.

- [ ] **Step 2: Ensure `isSuperAdmin` is available**

If `admin.users.list` (`packages/api/src/routers/admin/users.router.ts:8`) does not already select `isSuperAdmin`, add it to that `select`. Add `isSuperAdmin: boolean;` to the page's row type if missing.

- [ ] **Step 3: Show the override in the Access column**

In the `Access` column cell, render the super-admin case instead of the selector, because the selector has no effect on those users:

```tsx
        if (row.isSuperAdmin) {
          return (
            <span
              className="text-xs text-muted-foreground"
              title="Super admin overrides the app role at every gate — change it with the Super Admin toggle, not here."
            >
              super admin (overrides)
            </span>
          );
        }
```

Place this as an early return at the top of the existing `Access` cell function, leaving the current `<select>` untouched for everyone else.

- [ ] **Step 4: Build**

Run: `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/admin/users/page.tsx packages/api/src/routers/admin/users.router.ts
git commit -m "fix(web): show super-admin override in the Users access column

isSuperAdmin implies ADMIN at every appRole gate, so the Access selector
cannot demote such a user. Showing the override prevents a silent no-op.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification

- [ ] **Step 1: Full API test suite**

Run: `pnpm --filter @postautomation/api test`
Expected: all pass. `app-role-gating.test.ts` (29 tests) must stay green — it locks which routers are admin-gated.

- [ ] **Step 2: Types across the monorepo**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: exit 0

- [ ] **Step 3: Web build**

Run: `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`
Expected: exit 0. Per the repo's standing rule, tsc alone is NOT sufficient — SWC rejects things tsc accepts.

- [ ] **Step 4: Confirm nothing frozen was touched**

Run:

```bash
git diff main --stat -- \
  apps/worker/ \
  packages/social/ \
  'apps/web/app/api/oauth/callback/**' \
  packages/api/src/trpc.ts \
  packages/db/prisma/schema.prisma
```

Expected: **empty output.** The publish pipeline, OAuth callback, `orgProcedure`, and the schema are all out of scope. Non-empty output means the change exceeded its scope — stop and review.

- [ ] **Step 5: Manual smoke test (local, as super admin)**

1. `pnpm dev`, sign in as a super admin.
2. Visit `/admin/teams` → the Teams nav entry is present; the list renders.
3. Toggle to "All workspaces", open a single-member workspace, note its channel count.
4. Add a second user as MEMBER → toast confirms; the members table shows both roles.
5. If the added user's app role is `user`, the amber warning appears.
6. Click "Add as member" twice quickly → no 500; the second attempt reports "Already a member".
7. Confirm the OWNER row's remove button and role selector are both disabled.
8. Sign in as the added user → `/dashboard/channels` lists the workspace's channels.
9. Create and publish a post from the added user's session → succeeds, and the publish email goes to that user (posts carry `createdById`).

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feat/super-admin-teams-2026-08-05
```

Then open a PR against `main` summarizing: the teams router + UI, the Users-panel super-admin signal, and the two verified no-ops (FB/IG multi-account, simultaneous posting).

---

## Out of scope — do NOT implement

- **Channel migration between orgs.** Moving a `Channel` orphans its `PostTarget`s from their parent `Post` (which carries its own `organizationId`), creating history invisible to both orgs. Owner-approved: make the existing workspace the team instead.
- **Any change to the OAuth callback or provider code.** A second FB/IG account already works via `upsert` on `(organizationId, platform, platformId)`.
- **Any change to `orgProcedure`, the publish worker, or the schema.**
- **Changing any user's `appRole` or `isSuperAdmin` value.** The owner decides each one in the UI.
- **Granting OWNER**, or reintroducing the removed `VIEWER` role.
