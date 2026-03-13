# Super Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a platform-level Super Admin panel at `/admin` for managing all users, organizations, posts, channels, agents, media, queues, and audit logs.

**Architecture:** Integrated admin routes within the existing Next.js app. `isSuperAdmin` flag on User model, `superAdminProcedure` tRPC middleware, Edge-compatible JWT check in Next.js middleware, admin tRPC routers, and 9 admin pages using shadcn/ui components with a dark sidebar layout.

**Tech Stack:** Next.js 14 (App Router), tRPC, Prisma, NextAuth v5, BullMQ, shadcn/ui, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-13-super-admin-panel-design.md`

---

## File Structure

### Packages Modified
| File | Responsibility |
|------|---------------|
| `packages/db/prisma/schema.prisma` | Add isSuperAdmin, isBanned, deletedAt to User; make AuditLog.organizationId nullable |
| `packages/auth/src/config.ts` | Extend JWT/session with isSuperAdmin, isBanned; ban enforcement in authorize callback |
| `packages/api/src/trpc.ts` | Add superAdminProcedure, isBanned check in protectedProcedure, impersonation token handling |
| `packages/api/src/lib/audit.ts` | Make organizationId optional in AuditLogInput |
| `packages/api/src/root.ts` | Register admin router |

### New Backend Files
| File | Responsibility |
|------|---------------|
| `packages/api/src/routers/admin/index.ts` | Aggregated admin router exporting all sub-routers |
| `packages/api/src/routers/admin/overview.router.ts` | Platform stats + queue health |
| `packages/api/src/routers/admin/users.router.ts` | User CRUD + ban + impersonation |
| `packages/api/src/routers/admin/orgs.router.ts` | Organization management |
| `packages/api/src/routers/admin/posts.router.ts` | Cross-org post management + retry |
| `packages/api/src/routers/admin/channels.router.ts` | Channel management + token refresh |
| `packages/api/src/routers/admin/agents.router.ts` | Agent management |
| `packages/api/src/routers/admin/media.router.ts` | Media management + storage stats |
| `packages/api/src/routers/admin/queues.router.ts` | BullMQ job management |
| `packages/api/src/routers/admin/audit.router.ts` | Platform-wide audit logs |

### New Frontend Files
| File | Responsibility |
|------|---------------|
| `apps/web/app/admin/layout.tsx` | Admin shell: dark sidebar + header + content area |
| `apps/web/app/admin/login/page.tsx` | Admin-only login form (credentials only) |
| `apps/web/app/admin/page.tsx` | Overview dashboard with stats + queue health |
| `apps/web/app/admin/users/page.tsx` | Users data table |
| `apps/web/app/admin/orgs/page.tsx` | Organizations data table |
| `apps/web/app/admin/posts/page.tsx` | Posts data table |
| `apps/web/app/admin/channels/page.tsx` | Channels data table |
| `apps/web/app/admin/agents/page.tsx` | Agents data table |
| `apps/web/app/admin/media/page.tsx` | Media browser |
| `apps/web/app/admin/queues/page.tsx` | Queue dashboard |
| `apps/web/app/admin/audit/page.tsx` | Audit log viewer |
| `apps/web/components/admin/AdminSidebar.tsx` | Dark sidebar with nav links |
| `apps/web/components/admin/AdminHeader.tsx` | Top bar with breadcrumbs + admin badge |
| `apps/web/components/admin/DataTable.tsx` | Reusable sortable/paginated/searchable table |
| `apps/web/components/admin/StatCard.tsx` | Metric card component |
| `apps/web/components/admin/StatusBadge.tsx` | Colored status badge |
| `apps/web/components/admin/ConfirmDialog.tsx` | Destructive action confirmation modal |
| `apps/web/components/admin/QueueHealthCard.tsx` | Queue health visualization |
| `apps/web/components/admin/ImpersonationBanner.tsx` | Floating impersonation banner |

### Modified Frontend Files
| File | Responsibility |
|------|---------------|
| `apps/web/middleware.ts` | Add /admin route guard via getToken() |
| `apps/web/app/api/trpc/[trpc]/route.ts` | Pass impersonation cookie to tRPC context |

---

## Chunk 1: Database Schema + Auth Foundation

### Task 1: Add User Fields to Prisma Schema

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (User model, lines 12-30)

- [ ] **Step 1: Add isSuperAdmin, isBanned, deletedAt to User model**

In `packages/db/prisma/schema.prisma`, find the User model (line 12) and add the three new fields after the `password` field:

```prisma
model User {
  id            String    @id @default(cuid())
  name          String?
  email         String    @unique
  emailVerified DateTime?
  image         String?
  password      String?
  isSuperAdmin  Boolean   @default(false)
  isBanned      Boolean   @default(false)
  deletedAt     DateTime?

  accounts    Account[]
  sessions    Session[]
  memberships OrganizationMember[]
  auditLogs   AuditLog[]

  passwordResetTokens     PasswordResetToken[]
  emailVerificationTokens EmailVerificationToken[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 2: Make AuditLog.organizationId nullable**

In the same file, find the AuditLog model (line 372). Change `organizationId String` to `organizationId String?` and make the relation optional:

```prisma
model AuditLog {
  id             String   @id @default(cuid())
  organizationId String?
  organization   Organization? @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  userId         String?
  user           User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  action         String
  entityType     String
  entityId       String?
  metadata       Json?
  ipAddress      String?
  userAgent      String?
  createdAt      DateTime @default(now())

  @@index([organizationId, createdAt])
  @@index([userId])
  @@index([entityType, entityId])
}
```

- [ ] **Step 3: Push schema changes**

Run: `cd "/Users/sudhanshu6454/Posting Automation" && pnpm --filter @postautomation/db db:push`
Expected: Schema synced successfully, no errors

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "feat(db): add isSuperAdmin, isBanned, deletedAt to User; nullable AuditLog.organizationId"
```

---

### Task 2: Update Audit Helper

**Files:**
- Modify: `packages/api/src/lib/audit.ts`

- [ ] **Step 1: Make organizationId optional in AuditLogInput**

Open `packages/api/src/lib/audit.ts`. The current `AuditLogInput` interface (line 3) has `organizationId: string`. Change it to optional:

```typescript
interface AuditLogInput {
  organizationId?: string;  // was: string (required) — now optional for admin-level actions
  userId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}
```

The `createAuditLog` function (line 15) passes this directly to `prisma.auditLog.create()` — no changes needed there since Prisma now accepts `null` for the nullable field.

- [ ] **Step 2: Add admin audit action constants**

In the same file, after the existing `AUDIT_ACTIONS` constants (around line 74), add the admin action constants:

```typescript
  // Admin actions
  ADMIN_USER_SUPERADMIN_TOGGLED: "admin.user.superadmin_toggled",
  ADMIN_USER_BANNED: "admin.user.banned",
  ADMIN_USER_UNBANNED: "admin.user.unbanned",
  ADMIN_USER_DELETED: "admin.user.deleted",
  ADMIN_USER_IMPERSONATED: "admin.user.impersonated",
  ADMIN_ORG_PLAN_CHANGED: "admin.org.plan_changed",
  ADMIN_ORG_DELETED: "admin.org.deleted",
  ADMIN_POST_RETRIED: "admin.post.retried",
  ADMIN_CHANNEL_DISCONNECTED: "admin.channel.disconnected",
  ADMIN_CHANNEL_TOKEN_REFRESHED: "admin.channel.token_refreshed",
  ADMIN_AGENT_TOGGLED: "admin.agent.toggled",
  ADMIN_AGENT_DELETED: "admin.agent.deleted",
  ADMIN_MEDIA_DELETED: "admin.media.deleted",
  ADMIN_QUEUE_JOB_RETRIED: "admin.queue.job_retried",
  ADMIN_QUEUE_JOB_DELETED: "admin.queue.job_deleted",
```

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/lib/audit.ts
git commit -m "feat(api): make audit organizationId optional, add admin audit actions"
```

---

### Task 3: Extend NextAuth Config with isSuperAdmin + Ban Enforcement

**Files:**
- Modify: `packages/auth/src/config.ts` (lines 1-74)

- [ ] **Step 1: Add isSuperAdmin and isBanned to JWT callback**

In `packages/auth/src/config.ts`, find the JWT callback (around line 56). Currently it only adds `token.id = user.id`. Extend it to also add isSuperAdmin and isBanned:

```typescript
callbacks: {
  async jwt({ token, user, trigger }) {
    if (user) {
      token.id = user.id;
      token.isSuperAdmin = (user as any).isSuperAdmin ?? false;
      token.isBanned = (user as any).isBanned ?? false;
    }
    // On every token refresh (not just first login), re-check ban status from DB
    if (trigger === "update" || !user) {
      const { prisma } = await import("@postautomation/db");
      const dbUser = await prisma.user.findUnique({
        where: { id: token.id as string },
        select: { isBanned: true, isSuperAdmin: true },
      });
      if (dbUser) {
        token.isBanned = dbUser.isBanned;
        token.isSuperAdmin = dbUser.isSuperAdmin;
      }
    }
    return token;
  },
  async session({ session, token }) {
    if (token && session.user) {
      session.user.id = token.id as string;
      (session.user as any).isSuperAdmin = token.isSuperAdmin ?? false;
      (session.user as any).isBanned = token.isBanned ?? false;
    }
    return session;
  },
},
```

- [ ] **Step 2: Add ban check in credentials authorize callback**

In the same file, find the credentials `authorize` function. After the password verification succeeds but before returning the user, add a ban check:

```typescript
// After: const isValid = await bcrypt.compare(...)
// Before: return user

if (user.isBanned) {
  throw new Error("Account suspended");
}
if (user.deletedAt) {
  throw new Error("Account no longer exists");
}
```

Make sure the `findUnique` query for the user also selects `isBanned`, `deletedAt`, and `isSuperAdmin`:

```typescript
const user = await prisma.user.findUnique({
  where: { email: credentials.email as string },
  select: { id: true, email: true, name: true, image: true, password: true, isSuperAdmin: true, isBanned: true, deletedAt: true },
});
```

- [ ] **Step 3: Commit**

```bash
git add packages/auth/src/config.ts
git commit -m "feat(auth): extend JWT/session with isSuperAdmin/isBanned, add ban enforcement"
```

---

### Task 4: Add superAdminProcedure + Ban Check to tRPC

**Files:**
- Modify: `packages/api/src/trpc.ts` (lines 1-108)

- [ ] **Step 1: Extend createTRPCContext to accept impersonationToken**

In `packages/api/src/trpc.ts`, update the `createTRPCContext` function (line 13) to also accept `impersonationToken`:

```typescript
export async function createTRPCContext(opts: {
  session: Session | null;
  organizationId?: string;
  impersonationToken?: string;
}) {
  return {
    prisma,
    session: opts.session,
    organizationId: opts.organizationId,
    impersonationToken: opts.impersonationToken,
  };
}
```

Update the `TRPCContext` interface (line 7) to include the new field:

```typescript
export interface TRPCContext {
  prisma: typeof prisma;
  session: Session | null;
  organizationId?: string;
  impersonationToken?: string;
  isImpersonating?: boolean;
  adminUserId?: string;
}
```

- [ ] **Step 2: Add ban check to protectedProcedure**

In the `protectedProcedure` middleware (line 43), after the session check, add a ban check:

```typescript
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // Ban check
  if ((ctx.session.user as any).isBanned) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Account suspended" });
  }

  // Impersonation check
  let session = ctx.session;
  let isImpersonating = false;
  let adminUserId: string | undefined;

  if (ctx.impersonationToken) {
    try {
      const { jwtVerify } = await import("jose");
      const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "");
      const { payload } = await jwtVerify(ctx.impersonationToken, secret);
      if (payload.impersonatedUserId && payload.adminUserId) {
        const impersonatedUser = await ctx.prisma.user.findUnique({
          where: { id: payload.impersonatedUserId as string },
          select: { id: true, name: true, email: true, image: true },
        });
        if (impersonatedUser) {
          session = {
            ...ctx.session,
            user: { ...impersonatedUser } as any,
          };
          isImpersonating = true;
          adminUserId = payload.adminUserId as string;
        }
      }
    } catch {
      // Invalid/expired token — ignore, use normal session
    }
  }

  return next({
    ctx: { ...ctx, session, isImpersonating, adminUserId },
  });
});
```

- [ ] **Step 3: Add superAdminProcedure**

After the `protectedProcedure` definition, add the new `superAdminProcedure`:

```typescript
export const superAdminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!(ctx.session?.user as any)?.isSuperAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Super admin access required" });
  }
  return next({ ctx });
});
```

- [ ] **Step 4: Add jose dependency**

Run: `cd "/Users/sudhanshu6454/Posting Automation" && pnpm --filter @postautomation/api add jose`

(jose is a lightweight JWT library that works in all environments including Edge)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/trpc.ts packages/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add superAdminProcedure, ban check, impersonation support in tRPC"
```

---

### Task 5: Update Next.js Middleware for /admin Route Guard

**Files:**
- Modify: `apps/web/middleware.ts` (lines 1-40)

- [ ] **Step 1: Add admin route guard using getToken()**

In `apps/web/middleware.ts`, add the admin route check at the beginning of the middleware function, before the security headers logic:

```typescript
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Admin route guard
  if (pathname.startsWith("/admin") && pathname !== "/admin/login") {
    const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    if (!token || !(token as any).isSuperAdmin) {
      return NextResponse.redirect(new URL("/admin/login", request.url));
    }
  }

  // Existing security headers logic below...
  const response = NextResponse.next();
  // ... rest of existing middleware unchanged
```

- [ ] **Step 2: Update matcher to include /admin routes**

The existing matcher config (line 34) should already cover `/admin/*` routes since it matches everything except static files. Verify the matcher includes admin routes — no changes needed if the current matcher is:

```typescript
export const config = {
  matcher: ["/((?!_next|static|favicon\\.ico|api/auth).*)"],
};
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/middleware.ts
git commit -m "feat(web): add admin route guard in middleware using getToken()"
```

---

### Task 6: Pass Impersonation Cookie to tRPC Context

**Files:**
- Modify: `apps/web/app/api/trpc/[trpc]/route.ts` (lines 1-22)

- [ ] **Step 1: Read impersonation cookie and pass to context**

Update the tRPC route handler to read the `admin-impersonate` cookie:

```typescript
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@postautomation/api";
import { createTRPCContext } from "@postautomation/api";
import { auth } from "~/lib/auth";

const handler = async (req: Request) => {
  const session = await auth();
  const organizationId = req.headers.get("x-organization-id") ?? undefined;

  // Read impersonation cookie
  const cookieHeader = req.headers.get("cookie") ?? "";
  const impersonationToken = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("admin-impersonate="))
    ?.split("=")[1];

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () =>
      createTRPCContext({ session, organizationId, impersonationToken }),
  });
};

export { handler as GET, handler as POST };
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/api/trpc/[trpc]/route.ts
git commit -m "feat(web): pass impersonation cookie to tRPC context"
```

---

## Chunk 2: Admin tRPC Routers

### Task 7: Create Admin Router Structure + Overview Router

**Files:**
- Create: `packages/api/src/routers/admin/index.ts`
- Create: `packages/api/src/routers/admin/overview.router.ts`
- Modify: `packages/api/src/root.ts`

- [ ] **Step 1: Create overview router**

Create `packages/api/src/routers/admin/overview.router.ts`:

```typescript
import { createRouter, superAdminProcedure } from "../../trpc";
import { QUEUE_NAMES, createRedisConnection } from "@postautomation/queue";
import { Queue } from "bullmq";

export const adminOverviewRouter = createRouter({
  stats: superAdminProcedure.query(async ({ ctx }) => {
    const [userCount, orgCount, postsByStatus, channelCount, agentCount, recentActivity] =
      await Promise.all([
        ctx.prisma.user.count({ where: { deletedAt: null } }),
        ctx.prisma.organization.count(),
        ctx.prisma.post.groupBy({ by: ["status"], _count: true }),
        ctx.prisma.channel.count(),
        ctx.prisma.agent.count(),
        ctx.prisma.auditLog.findMany({
          take: 20,
          orderBy: { createdAt: "desc" },
          include: { user: { select: { name: true, email: true } }, organization: { select: { name: true } } },
        }),
      ]);

    // Queue health
    const connection = createRedisConnection();
    const queueNames = Object.values(QUEUE_NAMES);
    const queueHealth = await Promise.all(
      queueNames.map(async (name) => {
        const queue = new Queue(name, { connection });
        const counts = await queue.getJobCounts();
        await queue.close();
        return { name, ...counts };
      })
    );
    await connection.quit();

    const postStatusMap: Record<string, number> = {};
    postsByStatus.forEach((s) => {
      postStatusMap[s.status] = s._count;
    });

    return {
      users: userCount,
      organizations: orgCount,
      posts: postStatusMap,
      channels: channelCount,
      agents: agentCount,
      recentActivity,
      queueHealth,
    };
  }),
});
```

- [ ] **Step 2: Create admin index router**

Create `packages/api/src/routers/admin/index.ts`:

```typescript
import { createRouter } from "../../trpc";
import { adminOverviewRouter } from "./overview.router";

export const adminRouter = createRouter({
  overview: adminOverviewRouter,
});
```

- [ ] **Step 3: Register admin router in root**

In `packages/api/src/root.ts`, add the import and registration:

```typescript
import { adminRouter } from "./routers/admin";

// In the createRouter call, add:
admin: adminRouter,
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routers/admin/ packages/api/src/root.ts
git commit -m "feat(api): add admin overview router with platform stats + queue health"
```

---

### Task 8: Admin Users Router

**Files:**
- Create: `packages/api/src/routers/admin/users.router.ts`
- Modify: `packages/api/src/routers/admin/index.ts`

- [ ] **Step 1: Create users router**

Create `packages/api/src/routers/admin/users.router.ts`:

```typescript
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import { SignJWT } from "jose";

export const adminUsersRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        search: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(25),
      })
    )
    .query(async ({ ctx, input }) => {
      const where = {
        deletedAt: null,
        ...(input.search
          ? {
              OR: [
                { name: { contains: input.search, mode: "insensitive" as const } },
                { email: { contains: input.search, mode: "insensitive" as const } },
              ],
            }
          : {}),
      };

      const users = await ctx.prisma.user.findMany({
        where,
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          isSuperAdmin: true,
          isBanned: true,
          createdAt: true,
          _count: { select: { memberships: true } },
        },
      });

      const hasMore = users.length > input.limit;
      const items = hasMore ? users.slice(0, -1) : users;

      return {
        items,
        nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
      };
    }),

  getById: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.user.findUniqueOrThrow({
        where: { id: input.userId },
        include: {
          memberships: {
            include: { organization: { select: { id: true, name: true, slug: true, plan: true } } },
          },
        },
      });
    }),

  toggleSuperAdmin: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: input.userId } });

      // Guard: cannot demote last super admin
      if (user.isSuperAdmin) {
        const superAdminCount = await ctx.prisma.user.count({ where: { isSuperAdmin: true } });
        if (superAdminCount <= 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot demote the last super admin" });
        }
      }

      const updated = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: { isSuperAdmin: !user.isSuperAdmin },
      });

      createAuditLog({
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_USER_SUPERADMIN_TOGGLED,
        entityType: "User",
        entityId: input.userId,
        metadata: { isSuperAdmin: updated.isSuperAdmin },
      });

      return updated;
    }),

  toggleBan: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
      const updated = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: { isBanned: !user.isBanned },
      });

      createAuditLog({
        userId: ctx.session!.user.id,
        action: updated.isBanned ? AUDIT_ACTIONS.ADMIN_USER_BANNED : AUDIT_ACTIONS.ADMIN_USER_UNBANNED,
        entityType: "User",
        entityId: input.userId,
      });

      return updated;
    }),

  delete: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Soft delete — set deletedAt, remove memberships and sessions
      await ctx.prisma.$transaction([
        ctx.prisma.user.update({
          where: { id: input.userId },
          data: { deletedAt: new Date() },
        }),
        ctx.prisma.organizationMember.deleteMany({ where: { userId: input.userId } }),
        ctx.prisma.session.deleteMany({ where: { userId: input.userId } }),
      ]);

      createAuditLog({
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_USER_DELETED,
        entityType: "User",
        entityId: input.userId,
      });

      return { success: true };
    }),

  impersonate: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.prisma.user.findUniqueOrThrow({ where: { id: input.userId } });

      if (target.isSuperAdmin) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot impersonate another super admin" });
      }

      const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "");
      const token = await new SignJWT({
        impersonatedUserId: input.userId,
        adminUserId: ctx.session!.user.id,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("1h")
        .sign(secret);

      createAuditLog({
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_USER_IMPERSONATED,
        entityType: "User",
        entityId: input.userId,
        metadata: { impersonatedUserEmail: target.email },
      });

      return { token };
    }),

  stopImpersonation: superAdminProcedure.mutation(async () => {
    // Cookie clearing happens on the client side
    return { success: true };
  }),
});
```

- [ ] **Step 2: Register in admin index**

In `packages/api/src/routers/admin/index.ts`, add:

```typescript
import { adminUsersRouter } from "./users.router";

// In createRouter:
users: adminUsersRouter,
```

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routers/admin/
git commit -m "feat(api): add admin users router with CRUD, ban, impersonate"
```

---

### Task 9: Admin Orgs, Posts, Channels Routers

**Files:**
- Create: `packages/api/src/routers/admin/orgs.router.ts`
- Create: `packages/api/src/routers/admin/posts.router.ts`
- Create: `packages/api/src/routers/admin/channels.router.ts`
- Modify: `packages/api/src/routers/admin/index.ts`

- [ ] **Step 1: Create orgs router**

Create `packages/api/src/routers/admin/orgs.router.ts`:

```typescript
import { z } from "zod";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";

export const adminOrgsRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        search: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(25),
      })
    )
    .query(async ({ ctx, input }) => {
      const where = input.search
        ? { OR: [
            { name: { contains: input.search, mode: "insensitive" as const } },
            { slug: { contains: input.search, mode: "insensitive" as const } },
          ] }
        : {};

      const orgs = await ctx.prisma.organization.findMany({
        where,
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        select: {
          id: true, name: true, slug: true, plan: true, createdAt: true,
          _count: { select: { members: true, posts: true, channels: true } },
        },
      });

      const hasMore = orgs.length > input.limit;
      const items = hasMore ? orgs.slice(0, -1) : orgs;
      return { items, nextCursor: hasMore ? items[items.length - 1]?.id : undefined };
    }),

  getById: superAdminProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.organization.findUniqueOrThrow({
        where: { id: input.orgId },
        include: {
          members: { include: { user: { select: { id: true, name: true, email: true } } } },
          channels: { select: { id: true, platform: true, name: true, isActive: true } },
          posts: { take: 10, orderBy: { createdAt: "desc" }, select: { id: true, content: true, status: true, createdAt: true } },
        },
      });
    }),

  changePlan: superAdminProcedure
    .input(z.object({ orgId: z.string(), plan: z.enum(["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]) }))
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.prisma.organization.update({
        where: { id: input.orgId },
        data: { plan: input.plan },
      });
      createAuditLog({
        organizationId: input.orgId,
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_ORG_PLAN_CHANGED,
        entityType: "Organization",
        entityId: input.orgId,
        metadata: { newPlan: input.plan },
      });
      return updated;
    }),

  delete: superAdminProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.organization.delete({ where: { id: input.orgId } });
      createAuditLog({
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_ORG_DELETED,
        entityType: "Organization",
        entityId: input.orgId,
      });
      return { success: true };
    }),
});
```

- [ ] **Step 2: Create posts router**

Create `packages/api/src/routers/admin/posts.router.ts`:

```typescript
import { z } from "zod";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import { Queue } from "bullmq";
import { QUEUE_NAMES, createRedisConnection } from "@postautomation/queue";

export const adminPostsRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        status: z.string().optional(),
        platform: z.string().optional(),
        organizationId: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(25),
      })
    )
    .query(async ({ ctx, input }) => {
      const where: any = {};
      if (input.status) where.status = input.status;
      if (input.organizationId) where.organizationId = input.organizationId;
      if (input.platform) {
        where.targets = { some: { channel: { platform: input.platform } } };
      }

      const posts = await ctx.prisma.post.findMany({
        where,
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        include: {
          organization: { select: { name: true } },
          targets: { include: { channel: { select: { platform: true, name: true } } } },
        },
      });

      const hasMore = posts.length > input.limit;
      const items = hasMore ? posts.slice(0, -1) : posts;
      return { items, nextCursor: hasMore ? items[items.length - 1]?.id : undefined };
    }),

  getById: superAdminProcedure
    .input(z.object({ postId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.post.findUniqueOrThrow({
        where: { id: input.postId },
        include: {
          organization: { select: { name: true } },
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true }, orderBy: { order: "asc" } },
        },
      });
    }),

  retryFailed: superAdminProcedure
    .input(z.object({ postTargetId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.prisma.postTarget.findUniqueOrThrow({
        where: { id: input.postTargetId },
        include: { channel: true },
      });

      await ctx.prisma.postTarget.update({
        where: { id: input.postTargetId },
        data: { status: "QUEUED", errorMessage: null },
      });

      const connection = createRedisConnection();
      const queue = new Queue(QUEUE_NAMES.POST_PUBLISH, { connection });
      await queue.add("publish", {
        postTargetId: target.id,
        channelId: target.channelId,
        platform: target.channel.platform,
      }, { attempts: 3, backoff: { type: "exponential", delay: 30000 } });
      await queue.close();
      await connection.quit();

      createAuditLog({
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_POST_RETRIED,
        entityType: "PostTarget",
        entityId: input.postTargetId,
      });

      return { success: true };
    }),
});
```

- [ ] **Step 3: Create channels router**

Create `packages/api/src/routers/admin/channels.router.ts`:

```typescript
import { z } from "zod";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import { getSocialProvider } from "@postautomation/social";

export const adminChannelsRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(25),
      })
    )
    .query(async ({ ctx, input }) => {
      const channels = await ctx.prisma.channel.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        include: { organization: { select: { name: true } } },
      });

      const now = new Date();
      const fiveMin = 5 * 60 * 1000;
      const items = (channels.length > input.limit ? channels.slice(0, -1) : channels).map((ch) => ({
        ...ch,
        tokenStatus: !ch.tokenExpiresAt
          ? ("unknown" as const)
          : ch.tokenExpiresAt < now
            ? ("expired" as const)
            : ch.tokenExpiresAt < new Date(now.getTime() + fiveMin)
              ? ("expiring" as const)
              : ("valid" as const),
        hasRefreshToken: !!ch.refreshToken,
      }));

      return {
        items,
        nextCursor: channels.length > input.limit ? items[items.length - 1]?.id : undefined,
      };
    }),

  disconnect: superAdminProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const channel = await ctx.prisma.channel.findUniqueOrThrow({ where: { id: input.channelId } });
      await ctx.prisma.channel.delete({ where: { id: input.channelId } });
      createAuditLog({
        organizationId: channel.organizationId,
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_CHANNEL_DISCONNECTED,
        entityType: "Channel",
        entityId: input.channelId,
        metadata: { platform: channel.platform },
      });
      return { success: true };
    }),

  refreshToken: superAdminProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const channel = await ctx.prisma.channel.findUniqueOrThrow({ where: { id: input.channelId } });

      if (!channel.refreshToken) {
        return { success: false, message: "No refresh token available. Manual re-auth required." };
      }

      const provider = getSocialProvider(channel.platform as any);
      const platform = channel.platform.toUpperCase();
      const clientId = process.env[`${platform}_CLIENT_ID`] || "";
      const clientSecret = process.env[`${platform}_CLIENT_SECRET`] || "";

      if (!clientId || !clientSecret) {
        return { success: false, message: `Missing ${platform} OAuth credentials` };
      }

      const refreshed = await provider.refreshAccessToken(
        { accessToken: channel.accessToken, refreshToken: channel.refreshToken },
        { clientId, clientSecret, callbackUrl: `${process.env.APP_URL || ""}/api/oauth/callback/${channel.platform.toLowerCase()}`, scopes: [] }
      );

      await ctx.prisma.channel.update({
        where: { id: input.channelId },
        data: {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? channel.refreshToken,
          tokenExpiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt) : undefined,
        },
      });

      createAuditLog({
        organizationId: channel.organizationId,
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_CHANNEL_TOKEN_REFRESHED,
        entityType: "Channel",
        entityId: input.channelId,
        metadata: { platform: channel.platform },
      });

      return { success: true };
    }),
});
```

- [ ] **Step 4: Register all three in admin index**

Update `packages/api/src/routers/admin/index.ts`:

```typescript
import { createRouter } from "../../trpc";
import { adminOverviewRouter } from "./overview.router";
import { adminUsersRouter } from "./users.router";
import { adminOrgsRouter } from "./orgs.router";
import { adminPostsRouter } from "./posts.router";
import { adminChannelsRouter } from "./channels.router";

export const adminRouter = createRouter({
  overview: adminOverviewRouter,
  users: adminUsersRouter,
  orgs: adminOrgsRouter,
  posts: adminPostsRouter,
  channels: adminChannelsRouter,
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/admin/
git commit -m "feat(api): add admin orgs, posts, channels routers"
```

---

### Task 10: Admin Agents, Media, Queues, Audit Routers

**Files:**
- Create: `packages/api/src/routers/admin/agents.router.ts`
- Create: `packages/api/src/routers/admin/media.router.ts`
- Create: `packages/api/src/routers/admin/queues.router.ts`
- Create: `packages/api/src/routers/admin/audit.router.ts`
- Modify: `packages/api/src/routers/admin/index.ts`

- [ ] **Step 1: Create agents router**

Create `packages/api/src/routers/admin/agents.router.ts`:

```typescript
import { z } from "zod";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";

export const adminAgentsRouter = createRouter({
  list: superAdminProcedure
    .input(z.object({ cursor: z.string().optional(), limit: z.number().min(1).max(100).default(25) }))
    .query(async ({ ctx, input }) => {
      const agents = await ctx.prisma.agent.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        include: { organization: { select: { name: true } } },
      });
      const hasMore = agents.length > input.limit;
      const items = hasMore ? agents.slice(0, -1) : agents;
      return { items, nextCursor: hasMore ? items[items.length - 1]?.id : undefined };
    }),

  getById: superAdminProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.agent.findUniqueOrThrow({
        where: { id: input.agentId },
        include: {
          organization: { select: { name: true } },
          runs: { take: 20, orderBy: { createdAt: "desc" } },
        },
      });
    }),

  toggleActive: superAdminProcedure
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.prisma.agent.findUniqueOrThrow({ where: { id: input.agentId } });
      const updated = await ctx.prisma.agent.update({
        where: { id: input.agentId },
        data: { isActive: !agent.isActive },
      });
      createAuditLog({
        organizationId: agent.organizationId,
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_AGENT_TOGGLED,
        entityType: "Agent",
        entityId: input.agentId,
        metadata: { isActive: updated.isActive },
      });
      return updated;
    }),

  delete: superAdminProcedure
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.prisma.agent.findUniqueOrThrow({ where: { id: input.agentId } });
      await ctx.prisma.agent.delete({ where: { id: input.agentId } });
      createAuditLog({
        organizationId: agent.organizationId,
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_AGENT_DELETED,
        entityType: "Agent",
        entityId: input.agentId,
      });
      return { success: true };
    }),
});
```

- [ ] **Step 2: Create media router**

Create `packages/api/src/routers/admin/media.router.ts`:

```typescript
import { z } from "zod";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";

const s3 = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
  },
  forcePathStyle: true,
});

export const adminMediaRouter = createRouter({
  list: superAdminProcedure
    .input(z.object({ cursor: z.string().optional(), limit: z.number().min(1).max(100).default(25) }))
    .query(async ({ ctx, input }) => {
      const media = await ctx.prisma.media.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        include: { organization: { select: { name: true } } },
      });
      const hasMore = media.length > input.limit;
      const items = hasMore ? media.slice(0, -1) : media;
      return { items, nextCursor: hasMore ? items[items.length - 1]?.id : undefined };
    }),

  storageStats: superAdminProcedure.query(async ({ ctx }) => {
    const [totalCount, byType, byOrg] = await Promise.all([
      ctx.prisma.media.count(),
      ctx.prisma.media.groupBy({ by: ["mimeType"], _count: true }),
      ctx.prisma.media.groupBy({ by: ["organizationId"], _count: true }),
    ]);
    // Get org names for the grouped results
    const orgIds = byOrg.map((o) => o.organizationId);
    const orgs = await ctx.prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true, name: true },
    });
    const orgMap = Object.fromEntries(orgs.map((o) => [o.id, o.name]));

    return {
      totalCount,
      byType: byType.map((t) => ({ type: t.mimeType, count: t._count })),
      byOrg: byOrg.map((o) => ({ orgId: o.organizationId, orgName: orgMap[o.organizationId] || "Unknown", count: o._count })),
    };
  }),

  delete: superAdminProcedure
    .input(z.object({ mediaId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const media = await ctx.prisma.media.findUniqueOrThrow({ where: { id: input.mediaId } });

      // Delete from S3
      try {
        const key = new URL(media.url).pathname.replace(/^\//, "");
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET || "postautomation-media", Key: key }));
      } catch (err) {
        console.error("[AdminMedia] S3 delete failed:", err);
      }

      await ctx.prisma.media.delete({ where: { id: input.mediaId } });

      createAuditLog({
        organizationId: media.organizationId,
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_MEDIA_DELETED,
        entityType: "Media",
        entityId: input.mediaId,
      });
      return { success: true };
    }),
});
```

- [ ] **Step 3: Create queues router**

Create `packages/api/src/routers/admin/queues.router.ts`:

```typescript
import { z } from "zod";
import { Queue } from "bullmq";
import { QUEUE_NAMES, createRedisConnection } from "@postautomation/queue";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";

const VALID_QUEUES = Object.values(QUEUE_NAMES);

export const adminQueuesRouter = createRouter({
  stats: superAdminProcedure.query(async () => {
    const connection = createRedisConnection();
    const results = await Promise.all(
      VALID_QUEUES.map(async (name) => {
        const queue = new Queue(name, { connection });
        const counts = await queue.getJobCounts();
        await queue.close();
        return { name, ...counts };
      })
    );
    await connection.quit();
    return results;
  }),

  failedJobs: superAdminProcedure
    .input(z.object({ queueName: z.string().optional(), limit: z.number().min(1).max(100).default(50) }))
    .query(async ({ input }) => {
      const connection = createRedisConnection();
      const queues = input.queueName ? [input.queueName] : VALID_QUEUES;
      const allFailed: any[] = [];

      for (const name of queues) {
        const queue = new Queue(name, { connection });
        const failed = await queue.getFailed(0, input.limit);
        allFailed.push(...failed.map((job) => ({
          id: job.id,
          queue: name,
          name: job.name,
          data: job.data,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
          timestamp: job.timestamp,
          finishedOn: job.finishedOn,
        })));
        await queue.close();
      }

      await connection.quit();
      return allFailed.sort((a, b) => (b.finishedOn || 0) - (a.finishedOn || 0)).slice(0, input.limit);
    }),

  retryJob: superAdminProcedure
    .input(z.object({ queueName: z.string(), jobId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const connection = createRedisConnection();
      const queue = new Queue(input.queueName, { connection });
      const job = await queue.getJob(input.jobId);
      if (job) await job.retry();
      await queue.close();
      await connection.quit();

      createAuditLog({
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_QUEUE_JOB_RETRIED,
        entityType: "Job",
        entityId: input.jobId,
        metadata: { queue: input.queueName },
      });
      return { success: true };
    }),

  deleteJob: superAdminProcedure
    .input(z.object({ queueName: z.string(), jobId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const connection = createRedisConnection();
      const queue = new Queue(input.queueName, { connection });
      const job = await queue.getJob(input.jobId);
      if (job) await job.remove();
      await queue.close();
      await connection.quit();

      createAuditLog({
        userId: ctx.session!.user.id,
        action: AUDIT_ACTIONS.ADMIN_QUEUE_JOB_DELETED,
        entityType: "Job",
        entityId: input.jobId,
        metadata: { queue: input.queueName },
      });
      return { success: true };
    }),
});
```

- [ ] **Step 4: Create audit router**

Create `packages/api/src/routers/admin/audit.router.ts`:

```typescript
import { z } from "zod";
import { createRouter, superAdminProcedure } from "../../trpc";

export const adminAuditRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        userId: z.string().optional(),
        organizationId: z.string().optional(),
        action: z.string().optional(),
        entityType: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const where: any = {};
      if (input.userId) where.userId = input.userId;
      if (input.organizationId) where.organizationId = input.organizationId;
      if (input.action) where.action = { contains: input.action };
      if (input.entityType) where.entityType = input.entityType;
      if (input.startDate || input.endDate) {
        where.createdAt = {};
        if (input.startDate) where.createdAt.gte = new Date(input.startDate);
        if (input.endDate) where.createdAt.lte = new Date(input.endDate);
      }

      const logs = await ctx.prisma.auditLog.findMany({
        where,
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { name: true, email: true } },
          organization: { select: { name: true } },
        },
      });

      const hasMore = logs.length > input.limit;
      const items = hasMore ? logs.slice(0, -1) : logs;
      return { items, nextCursor: hasMore ? items[items.length - 1]?.id : undefined };
    }),
});
```

- [ ] **Step 5: Update admin index with all routers**

Update `packages/api/src/routers/admin/index.ts` to the final version:

```typescript
import { createRouter } from "../../trpc";
import { adminOverviewRouter } from "./overview.router";
import { adminUsersRouter } from "./users.router";
import { adminOrgsRouter } from "./orgs.router";
import { adminPostsRouter } from "./posts.router";
import { adminChannelsRouter } from "./channels.router";
import { adminAgentsRouter } from "./agents.router";
import { adminMediaRouter } from "./media.router";
import { adminQueuesRouter } from "./queues.router";
import { adminAuditRouter } from "./audit.router";

export const adminRouter = createRouter({
  overview: adminOverviewRouter,
  users: adminUsersRouter,
  orgs: adminOrgsRouter,
  posts: adminPostsRouter,
  channels: adminChannelsRouter,
  agents: adminAgentsRouter,
  media: adminMediaRouter,
  queues: adminQueuesRouter,
  audit: adminAuditRouter,
});
```

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routers/admin/
git commit -m "feat(api): add admin agents, media, queues, audit routers"
```

---

## Chunk 3: Admin UI Components + Layout

### Task 11: Create Shared Admin Components

**Files:**
- Create: `apps/web/components/admin/StatCard.tsx`
- Create: `apps/web/components/admin/StatusBadge.tsx`
- Create: `apps/web/components/admin/ConfirmDialog.tsx`
- Create: `apps/web/components/admin/QueueHealthCard.tsx`
- Create: `apps/web/components/admin/DataTable.tsx`

- [ ] **Step 1: Create StatCard**

Create `apps/web/components/admin/StatCard.tsx`:

```tsx
import { Card, CardContent } from "~/components/ui/card";
import { type LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  description?: string;
}

export function StatCard({ title, value, icon: Icon, description }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="mt-1 text-3xl font-bold">{value}</p>
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          <div className="rounded-lg bg-primary/10 p-3">
            <Icon className="h-6 w-6 text-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Create StatusBadge**

Create `apps/web/components/admin/StatusBadge.tsx`:

```tsx
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

const statusStyles: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700",
  SCHEDULED: "bg-blue-100 text-blue-700",
  QUEUED: "bg-yellow-100 text-yellow-700",
  PUBLISHING: "bg-orange-100 text-orange-700",
  PUBLISHED: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
  // Token statuses
  valid: "bg-green-100 text-green-700",
  expiring: "bg-yellow-100 text-yellow-700",
  expired: "bg-red-100 text-red-700",
  unknown: "bg-gray-100 text-gray-700",
  // Plans
  FREE: "bg-gray-100 text-gray-700",
  STARTER: "bg-blue-100 text-blue-700",
  PROFESSIONAL: "bg-purple-100 text-purple-700",
  ENTERPRISE: "bg-amber-100 text-amber-700",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("text-xs font-medium", statusStyles[status] || "", className)}>
      {status}
    </Badge>
  );
}
```

- [ ] **Step 3: Create ConfirmDialog**

Create `apps/web/components/admin/ConfirmDialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "~/components/ui/dialog";

interface ConfirmDialogProps {
  trigger: React.ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "destructive" | "default";
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({ trigger, title, description, confirmLabel = "Confirm", variant = "destructive", onConfirm }: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant={variant} onClick={handleConfirm} disabled={loading}>
            {loading ? "Processing..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Create QueueHealthCard**

Create `apps/web/components/admin/QueueHealthCard.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

interface QueueStats {
  name: string;
  waiting?: number;
  active?: number;
  completed?: number;
  failed?: number;
}

export function QueueHealthCard({ queues }: { queues: QueueStats[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Queue Health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {queues.map((q) => (
            <div key={q.name} className="flex items-center justify-between text-sm">
              <span className="font-mono text-xs">{q.name}</span>
              <div className="flex gap-3 text-xs">
                <span className="text-yellow-600">{q.waiting ?? 0} waiting</span>
                <span className="text-blue-600">{q.active ?? 0} active</span>
                <span className="text-red-600">{q.failed ?? 0} failed</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Create DataTable**

Create `apps/web/components/admin/DataTable.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";

export interface Column<T> {
  header: string;
  accessorKey?: keyof T;
  cell?: (row: T) => React.ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  searchPlaceholder?: string;
  onSearch?: (query: string) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoading?: boolean;
}

export function DataTable<T extends { id: string }>({
  columns, data, searchPlaceholder = "Search...", onSearch, hasMore, onLoadMore, isLoading,
}: DataTableProps<T>) {
  const [search, setSearch] = useState("");

  const handleSearch = (value: string) => {
    setSearch(value);
    onSearch?.(value);
  };

  return (
    <div className="space-y-4">
      {onSearch && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      )}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col, i) => (
                <TableHead key={i} className={col.className}>{col.header}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-10 text-center text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-10 text-center text-muted-foreground">
                  No results found
                </TableCell>
              </TableRow>
            ) : (
              data.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((col, i) => (
                    <TableCell key={i} className={col.className}>
                      {col.cell ? col.cell(row) : col.accessorKey ? String((row as any)[col.accessorKey] ?? "") : ""}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/admin/
git commit -m "feat(web): add shared admin UI components (StatCard, DataTable, StatusBadge, etc.)"
```

---

### Task 12: Create Admin Layout + Sidebar + Header

**Files:**
- Create: `apps/web/components/admin/AdminSidebar.tsx`
- Create: `apps/web/components/admin/AdminHeader.tsx`
- Create: `apps/web/components/admin/ImpersonationBanner.tsx`
- Create: `apps/web/app/admin/layout.tsx`

- [ ] **Step 1: Create AdminSidebar**

Create `apps/web/components/admin/AdminSidebar.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "~/lib/utils";
import {
  LayoutDashboard, Users, Building2, FileText, Radio, Bot, Image, Server, ScrollText,
} from "lucide-react";

const navItems = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/orgs", label: "Organizations", icon: Building2 },
  { href: "/admin/posts", label: "Posts", icon: FileText },
  { href: "/admin/channels", label: "Channels", icon: Radio },
  { href: "/admin/agents", label: "Agents", icon: Bot },
  { href: "/admin/media", label: "Media", icon: Image },
  { href: "/admin/queues", label: "Queues", icon: Server },
  { href: "/admin/audit", label: "Audit Logs", icon: ScrollText },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-60 flex-col bg-gray-950 text-gray-300">
      <div className="flex h-14 items-center gap-2 border-b border-gray-800 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-red-600 text-xs font-bold text-white">
          SA
        </div>
        <span className="text-sm font-semibold text-white">Super Admin</span>
      </div>
      <nav className="flex-1 space-y-0.5 p-3">
        {navItems.map((item) => {
          const isActive = item.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-gray-800 p-3">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-gray-500 hover:text-gray-300"
        >
          Back to Dashboard
        </Link>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Create AdminHeader**

Create `apps/web/components/admin/AdminHeader.tsx`:

```tsx
"use client";

import { usePathname } from "next/navigation";
import { Badge } from "~/components/ui/badge";

const pageNames: Record<string, string> = {
  "/admin": "Overview",
  "/admin/users": "Users",
  "/admin/orgs": "Organizations",
  "/admin/posts": "Posts",
  "/admin/channels": "Channels",
  "/admin/agents": "Agents",
  "/admin/media": "Media",
  "/admin/queues": "Queues",
  "/admin/audit": "Audit Logs",
};

export function AdminHeader() {
  const pathname = usePathname();
  const title = pageNames[pathname] || "Admin";

  return (
    <header className="flex h-14 items-center justify-between border-b px-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <Badge variant="outline" className="bg-red-50 text-red-700 text-[10px]">
          SUPER ADMIN
        </Badge>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Create ImpersonationBanner**

Create `apps/web/components/admin/ImpersonationBanner.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { trpc } from "~/lib/trpc/client";

export function ImpersonationBanner() {
  const [impersonating, setImpersonating] = useState(false);
  const stopImpersonation = trpc.admin.users.stopImpersonation.useMutation();

  useEffect(() => {
    // Check for impersonation cookie
    const hasCookie = document.cookie.includes("admin-impersonate=");
    setImpersonating(hasCookie);
  }, []);

  if (!impersonating) return null;

  const handleExit = async () => {
    await stopImpersonation.mutateAsync();
    // Clear the cookie client-side
    document.cookie = "admin-impersonate=; path=/; max-age=0";
    window.location.href = "/admin/users";
  };

  return (
    <div className="fixed left-0 right-0 top-0 z-[100] flex items-center justify-center gap-4 bg-amber-500 px-4 py-2 text-sm font-medium text-black">
      <span>You are impersonating a user</span>
      <Button size="sm" variant="outline" className="h-7 bg-white text-black" onClick={handleExit}>
        Exit Impersonation
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Create admin layout**

Create `apps/web/app/admin/layout.tsx`:

```tsx
import { AdminSidebar } from "~/components/admin/AdminSidebar";
import { AdminHeader } from "~/components/admin/AdminHeader";
import { Providers } from "~/components/providers";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div className="flex h-screen overflow-hidden">
        <AdminSidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <AdminHeader />
          <main className="flex-1 overflow-auto bg-gray-50 p-6">
            {children}
          </main>
        </div>
      </div>
    </Providers>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/admin/AdminSidebar.tsx apps/web/components/admin/AdminHeader.tsx apps/web/components/admin/ImpersonationBanner.tsx apps/web/app/admin/layout.tsx
git commit -m "feat(web): add admin layout with dark sidebar, header, impersonation banner"
```

---

## Chunk 4: Admin Pages

### Task 13: Admin Login Page

**Files:**
- Create: `apps/web/app/admin/login/page.tsx`

- [ ] **Step 1: Create admin login page**

Create `apps/web/app/admin/login/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Shield } from "lucide-react";

export default function AdminLoginPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // If already logged in as super admin, redirect
  if (session?.user && (session.user as any).isSuperAdmin) {
    router.replace("/admin");
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError("Invalid credentials");
        setLoading(false);
        return;
      }

      // Fetch session to check isSuperAdmin
      const res = await fetch("/api/auth/session");
      const sess = await res.json();

      if (!sess?.user?.isSuperAdmin) {
        await signOut({ redirect: false });
        setError("You do not have super admin access");
        setLoading(false);
        return;
      }

      router.push("/admin");
    } catch {
      setError("Something went wrong");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
            <Shield className="h-6 w-6 text-red-600" />
          </div>
          <CardTitle>Super Admin</CardTitle>
          <CardDescription>Sign in with your admin credentials</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/admin/login/
git commit -m "feat(web): add admin login page"
```

---

### Task 14: Overview Dashboard Page

**Files:**
- Create: `apps/web/app/admin/page.tsx`

- [ ] **Step 1: Create overview page**

Create `apps/web/app/admin/page.tsx`:

```tsx
"use client";

import { trpc } from "~/lib/trpc/client";
import { StatCard } from "~/components/admin/StatCard";
import { QueueHealthCard } from "~/components/admin/QueueHealthCard";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Users, Building2, FileText, Radio, Bot } from "lucide-react";

export default function AdminOverviewPage() {
  const { data, isLoading } = trpc.admin.overview.stats.useQuery();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
      </div>
    );
  }

  const totalPosts = data ? Object.values(data.posts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard title="Users" value={data?.users ?? 0} icon={Users} />
        <StatCard title="Organizations" value={data?.organizations ?? 0} icon={Building2} />
        <StatCard title="Posts" value={totalPosts} icon={FileText} description={`${data?.posts?.PUBLISHED ?? 0} published, ${data?.posts?.FAILED ?? 0} failed`} />
        <StatCard title="Channels" value={data?.channels ?? 0} icon={Radio} />
        <StatCard title="Agents" value={data?.agents ?? 0} icon={Bot} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <QueueHealthCard queues={data?.queueHealth ?? []} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {data?.recentActivity?.map((log: any) => (
                <div key={log.id} className="flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium">{log.user?.name || log.user?.email || "System"}</span>
                    <span className="ml-2 text-muted-foreground">{log.action}</span>
                    {log.organization && (
                      <span className="ml-1 text-xs text-muted-foreground">in {log.organization.name}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
              {(!data?.recentActivity || data.recentActivity.length === 0) && (
                <p className="text-sm text-muted-foreground">No recent activity</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/admin/page.tsx
git commit -m "feat(web): add admin overview dashboard page"
```

---

### Task 15: Users Page

**Files:**
- Create: `apps/web/app/admin/users/page.tsx`

- [ ] **Step 1: Create users page**

Create `apps/web/app/admin/users/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { ConfirmDialog } from "~/components/admin/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { useToast } from "~/hooks/use-toast";
import { Shield, Ban, Trash2, LogIn } from "lucide-react";
import { useDebounce } from "~/hooks/use-debounce";

export default function AdminUsersPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, refetch } = trpc.admin.users.list.useQuery({ search: debouncedSearch || undefined });
  const toggleSuperAdmin = trpc.admin.users.toggleSuperAdmin.useMutation({ onSuccess: () => { refetch(); toast({ title: "Updated" }); } });
  const toggleBan = trpc.admin.users.toggleBan.useMutation({ onSuccess: () => { refetch(); toast({ title: "Updated" }); } });
  const deleteUser = trpc.admin.users.delete.useMutation({ onSuccess: () => { refetch(); toast({ title: "User deleted" }); } });
  const impersonate = trpc.admin.users.impersonate.useMutation();

  const handleImpersonate = async (userId: string) => {
    const result = await impersonate.mutateAsync({ userId });
    document.cookie = `admin-impersonate=${result.token}; path=/; max-age=3600; secure; samesite=strict`;
    window.location.href = "/dashboard";
  };

  const columns: Column<any>[] = [
    { header: "Name", cell: (row) => (
      <div>
        <p className="font-medium">{row.name || "—"}</p>
        <p className="text-xs text-muted-foreground">{row.email}</p>
      </div>
    )},
    { header: "Orgs", cell: (row) => row._count?.memberships ?? 0 },
    { header: "Role", cell: (row) => (
      <div className="flex gap-1">
        {row.isSuperAdmin && <StatusBadge status="ENTERPRISE" className="!bg-red-100 !text-red-700">Admin</StatusBadge>}
        {row.isBanned && <StatusBadge status="FAILED">Banned</StatusBadge>}
      </div>
    )},
    { header: "Joined", cell: (row) => new Date(row.createdAt).toLocaleDateString() },
    { header: "Actions", className: "text-right", cell: (row) => (
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Toggle Admin" onClick={() => toggleSuperAdmin.mutate({ userId: row.id })}>
          <Shield className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" title={row.isBanned ? "Unban" : "Ban"} onClick={() => toggleBan.mutate({ userId: row.id })}>
          <Ban className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Impersonate" onClick={() => handleImpersonate(row.id)}>
          <LogIn className="h-4 w-4" />
        </Button>
        <ConfirmDialog
          trigger={<Button variant="ghost" size="icon" className="h-8 w-8 text-destructive"><Trash2 className="h-4 w-4" /></Button>}
          title="Delete User"
          description="This will soft-delete the user and remove all their memberships. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => deleteUser.mutateAsync({ userId: row.id })}
        />
      </div>
    )},
  ];

  return (
    <DataTable
      columns={columns}
      data={data?.items ?? []}
      isLoading={isLoading}
      searchPlaceholder="Search by name or email..."
      onSearch={setSearch}
      hasMore={!!data?.nextCursor}
    />
  );
}
```

Note: This page uses a `useDebounce` hook. Check if `apps/web/hooks/use-debounce.ts` exists. If not, create it:

```tsx
import { useState, useEffect } from "react";
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/admin/users/ apps/web/hooks/use-debounce.ts
git commit -m "feat(web): add admin users management page"
```

---

### Task 16: Remaining Admin Pages (Orgs, Posts, Channels, Agents, Media, Queues, Audit)

**Files:**
- Create: `apps/web/app/admin/orgs/page.tsx`
- Create: `apps/web/app/admin/posts/page.tsx`
- Create: `apps/web/app/admin/channels/page.tsx`
- Create: `apps/web/app/admin/agents/page.tsx`
- Create: `apps/web/app/admin/media/page.tsx`
- Create: `apps/web/app/admin/queues/page.tsx`
- Create: `apps/web/app/admin/audit/page.tsx`

Each page follows the same pattern: use `trpc.admin.<resource>.list.useQuery()`, define columns for `DataTable`, add action buttons with mutations. Build each page following the exact same structure as the Users page (Task 15), adapting the columns and actions per the spec:

- [ ] **Step 1: Create orgs page** — Table with name, slug, plan (StatusBadge), member count, post count, createdAt. Actions: changePlan (select dropdown), view details (Sheet), delete (ConfirmDialog).

- [ ] **Step 2: Create posts page** — Table with content preview (truncated), org name, status (StatusBadge), platforms (badges), createdAt. Filter selects for status/platform/org. Actions: view details (Sheet with targets + errors), retry failed (Button on FAILED targets).

- [ ] **Step 3: Create channels page** — Table with platform (PlatformIcon from existing component), name, org name, token status (StatusBadge: valid/expiring/expired), hasRefreshToken. Actions: refresh token (disabled if no refresh token), disconnect (ConfirmDialog).

- [ ] **Step 4: Create agents page** — Table with name, org name, type, isActive (toggle), last run date. Actions: toggle active (Button), view details (Sheet with run history), delete (ConfirmDialog).

- [ ] **Step 5: Create media page** — Grid/table with thumbnail preview, org name, mimeType, createdAt. Storage stats summary at top using `admin.media.storageStats`. Actions: delete (ConfirmDialog).

- [ ] **Step 6: Create queues page** — Queue stats cards at top using `admin.queues.stats`. Below: failed jobs table using `admin.queues.failedJobs`. Actions: retry job, delete job.

- [ ] **Step 7: Create audit page** — Table with user name, action, entity type, org name, date. Filter inputs for userId, organizationId, action, date range.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/admin/
git commit -m "feat(web): add all remaining admin pages (orgs, posts, channels, agents, media, queues, audit)"
```

---

## Chunk 5: Final Integration + Seed

### Task 17: Seed Super Admin + Verify

- [ ] **Step 1: Push schema to production database**

```bash
cd "/Users/sudhanshu6454/Posting Automation"
pnpm --filter @postautomation/db db:push
```

- [ ] **Step 2: Set your user as super admin**

Run against the database to set your account as super admin (replace with your actual email):

```bash
cd "/Users/sudhanshu6454/Posting Automation"
npx prisma db execute --stdin <<< "UPDATE \"User\" SET \"isSuperAdmin\" = true WHERE email = 'your-email@example.com';"
```

Or via Prisma Studio: `pnpm --filter @postautomation/db db:studio` — find your user, set isSuperAdmin to true.

- [ ] **Step 3: Build and verify**

```bash
cd "/Users/sudhanshu6454/Posting Automation"
pnpm build
```

Expected: Build succeeds with no TypeScript errors. The `/admin` routes should appear in the build output.

- [ ] **Step 4: Test locally**

1. Start dev server: `pnpm dev`
2. Navigate to `http://localhost:3000/admin` — should redirect to `/admin/login`
3. Login with your credentials — should reach the admin overview dashboard
4. Verify sidebar navigation works for all 9 pages
5. Verify a non-super-admin user gets rejected at `/admin/login`

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete super admin panel with all pages and routers"
```

---

## Deployment

After all tasks are complete:

```bash
# Deploy to production
ssh deploy@172.236.181.160 "cd /home/deploy/postautomation && git pull && docker compose -f docker-compose.prod.yml up -d --build web worker && docker exec postautomation-web-1 npx prisma db push"
```

Then set super admin on production:
```bash
ssh deploy@172.236.181.160 "docker exec postautomation-web-1 npx prisma db execute --stdin <<< \"UPDATE \\\"User\\\" SET \\\"isSuperAdmin\\\" = true WHERE email = 'your-email@example.com';\""
```
