# Super Admin Panel — Design Spec

## Overview

A platform-level admin panel at `/admin` for the PostAutomation operator to manage all users, organizations, posts, channels, agents, media, queues, and audit logs across the entire platform. Built as integrated routes within the existing Next.js app, reusing tRPC, NextAuth, and shadcn/ui.

## Auth & Access Control

### Schema Change

Add to the `User` model in `packages/db/prisma/schema.prisma`:

```prisma
isSuperAdmin Boolean @default(false)
```

Seed the operator's account via a one-time Prisma script or raw SQL:

```sql
UPDATE "User" SET "isSuperAdmin" = true WHERE email = '<operator-email>';
```

### Login Flow

- **Route:** `/admin/login` — standalone page with email + password form only
- Uses `signIn("credentials", ...)` from NextAuth — the page only renders the credentials form, no OAuth provider buttons
- After auth, checks `user.isSuperAdmin === true`. If not super admin, calls `signOut()` and shows "Unauthorized" error
- If valid, redirects to `/admin`
- **Rate limiting:** Apply rate limiting on the admin login route — max 5 attempts per IP per 15 minutes. Use a simple in-memory map or Redis counter (Redis is already available). Return 429 on exceeded limit

### Ban Enforcement

When `isBanned` is true, the user is blocked at two points:

1. **NextAuth `authorize` callback** in `packages/auth/src/config.ts`: After verifying credentials, check `user.isBanned`. If true, return `null` (login rejected) with error "Account suspended"
2. **JWT callback**: On every token refresh, re-check `isBanned` from the DB. If banned, return empty token to force sign-out
3. **`protectedProcedure`** in tRPC: Check `ctx.session.user.isBanned`. If true, throw `TRPCError({ code: "FORBIDDEN", message: "Account suspended" })`

### Session Extension

In `packages/auth/src/config.ts`, extend the JWT and session callbacks:

- **JWT callback:** Add `isSuperAdmin: user.isSuperAdmin` to the token
- **Session callback:** Expose `session.user.isSuperAdmin` from the token

### tRPC Middleware

New `superAdminProcedure` in `packages/api/src/trpc.ts`:

- Extends `protectedProcedure`
- Checks `ctx.session.user.isSuperAdmin === true`
- Throws `TRPCError({ code: "FORBIDDEN" })` if not
- All admin routers use this procedure exclusively

### Next.js Middleware

Update `apps/web/middleware.ts`:

- Match `/admin/*` routes (except `/admin/login`)
- Decode the NextAuth JWT directly using `getToken()` from `next-auth/jwt` (Edge-compatible, no DB call needed)
- Check `token.isSuperAdmin === true`
- Redirect to `/admin/login` if no token or not super admin
- Import: `import { getToken } from "next-auth/jwt"`

## Pages & Routes

### Layout

`apps/web/app/admin/layout.tsx`:

- Dark sidebar navigation (visually distinct from user dashboard)
- Top bar with "Super Admin" badge + operator name
- Sidebar sections: Overview, Users, Organizations, Posts, Channels, Agents, Media, Queues, Audit Logs

### Page Map

| Page | Route | Purpose |
|------|-------|---------|
| Overview | `/admin` | System stats (total users, orgs, posts, channels, agents), recent activity feed, queue health |
| Users | `/admin/users` | All users table. Search/filter. Actions: view, toggle superAdmin, ban/disable, impersonate |
| Organizations | `/admin/orgs` | All orgs with plan, member count, post count. Actions: change plan, view details, delete |
| Posts | `/admin/posts` | All posts across orgs. Filter by status/platform/org. View errors. Retry failed posts |
| Channels | `/admin/channels` | All channels with token health. Disconnect or refresh tokens |
| Agents | `/admin/agents` | All AI agents. View config, run history. Toggle active, delete |
| Media | `/admin/media` | Media browser across orgs. Storage usage stats. Delete media |
| Queues | `/admin/queues` | BullMQ dashboard: pending/active/completed/failed per queue. Retry/delete jobs |
| Audit Logs | `/admin/audit` | Platform-wide audit log. Filter by user, org, action, date range |

## tRPC Admin Routers

All routers use `superAdminProcedure`. Registered under `admin.*` namespace in `packages/api/src/root.ts`.

### admin.overview

- `stats` query: Aggregated counts (users, orgs, posts by status, channels, agents) + recent activity (last 20 audit log entries) + queue health via BullMQ `getJobCounts()`

### admin.users

- `list` query: Paginated, searchable by name/email. Returns id, name, email, isSuperAdmin, createdAt, org count
- `getById` query: Full user detail with memberships and orgs
- `toggleSuperAdmin` mutation: Flip `isSuperAdmin` flag. **Guard:** Cannot demote the last remaining super admin (count super admins first, reject if count === 1 and target is self). Logs `admin.user.superadmin_toggled`
- `toggleBan` mutation: Flip `isBanned` flag. Logs `admin.user.banned` / `admin.user.unbanned`
- `delete` mutation: **Soft delete** — sets `deletedAt` timestamp (add `deletedAt DateTime?` to User model). Does NOT cascade-delete posts/agents (they remain under the org). Removes all sessions and memberships. Logs `admin.user.deleted`
- `impersonate` mutation: Returns short-lived impersonation token. Logs `admin.user.impersonated`. See Impersonation section
- `stopImpersonation` mutation: Clears the `admin-impersonate` cookie and returns success. No audit log needed (the original impersonation is already logged)

### admin.orgs

- `list` query: Paginated, searchable. Returns id, name, slug, plan, member count, post count, createdAt
- `getById` query: Full org with members, channels, recent posts
- `changePlan` mutation: Update org plan. Logs `admin.org.plan_changed`
- `delete` mutation: Cascade delete org. Logs `admin.org.deleted`

### admin.posts

- `list` query: Paginated. Filters: status, platform, organizationId. Includes org name, channel info
- `getById` query: Post with all targets, errors, media attachments
- `retryFailed` mutation: Re-queues failed PostTarget via BullMQ. Resets status to QUEUED. Logs `admin.post.retried`

### admin.channels

- `list` query: All channels with org name, platform, token expiry status (computed: expired/expiring/valid)
- `disconnect` mutation: Remove channel. Logs `admin.channel.disconnected`
- `refreshToken` mutation: Force token refresh using the platform provider's `refreshAccessToken()`. **Only available for platforms that have a `refreshToken` stored in the DB.** If the channel has no refresh token (e.g., some OAuth 1.0a flows), the button is disabled and shows "Manual re-auth required". Logs `admin.channel.token_refreshed`

### admin.agents

- `list` query: All agents with org name, type, active status, last run
- `getById` query: Agent with config and recent run history
- `toggleActive` mutation: Flip isActive. Logs `admin.agent.toggled`
- `delete` mutation: Delete agent. Logs `admin.agent.deleted`

### admin.media

- `list` query: All media with org name, type, size, createdAt
- `storageStats` query: Total size, count by type, size by org
- `delete` mutation: Delete media record + S3 object. Logs `admin.media.deleted`

### admin.queues

- `stats` query: Job counts per queue via BullMQ Queue API. Actual queue names: `post-publish`, `token-refresh`, `analytics-sync`, `media-process`, `webhook-delivery`, `rss-sync`, `notification-send`, `agent-run`. Instantiate Queue objects in the router using `createRedisConnection()` from `@postautomation/queue` (add as dependency of `packages/api`)
- `failedJobs` query: List failed jobs with error messages, timestamps, queue name
- `retryJob` mutation: Retry a specific failed job by queue name + job ID. Logs `admin.queue.job_retried`
- `deleteJob` mutation: Remove a specific job by queue name + job ID. Logs `admin.queue.job_deleted`

### admin.audit

- `list` query: Platform-wide audit logs (no org scoping). Filters: userId, organizationId, action, entityType, date range. Paginated

## Impersonation

### Flow

1. Admin clicks "Login as" on a user row
2. `admin.users.impersonate` mutation creates a signed JWT with `{ impersonatedUserId, adminUserId, exp: 1h }`, signed with `NEXTAUTH_SECRET` (already available in env — reusing it is acceptable since only super admins can trigger this flow, and the JWT payload is distinct from session tokens)
3. Token stored in `admin-impersonate` cookie (httpOnly, secure, sameSite: strict, 1h max-age)
4. Page redirects to `/dashboard`

### Middleware Integration

The impersonation cookie must be plumbed into tRPC context:

1. In `apps/web/app/api/trpc/[trpc]/route.ts` (the tRPC HTTP handler): read the `admin-impersonate` cookie from the request headers and pass it into `createTRPCContext()` as `impersonationToken`
2. In `packages/api/src/trpc.ts`, extend `createTRPCContext` to accept `impersonationToken?: string`
3. In `protectedProcedure` middleware:
   - If `ctx.impersonationToken` is present, verify JWT signature (using `NEXTAUTH_SECRET`) and expiry
   - If valid, load the impersonated user from DB and override `session.user`
   - Set `ctx.isImpersonating = true` and `ctx.adminUserId` on the context
   - If JWT is expired or invalid, ignore it (don't block the request — just use normal session)

### UI

- `ImpersonationBanner.tsx`: Fixed top banner showing "Impersonating [user name] — [Exit]"
- Exit button calls `admin.users.stopImpersonation` which clears the cookie and redirects to `/admin/users`

### Safeguards

- Impersonation sessions max 1 hour
- All actions during impersonation are logged with the admin's real userId in audit metadata
- Cannot impersonate another super admin

## Frontend Components

Located in `apps/web/components/admin/`:

| Component | Purpose |
|-----------|---------|
| `AdminSidebar.tsx` | Dark sidebar with nav links, active state, collapse toggle |
| `AdminHeader.tsx` | Top bar with breadcrumbs, admin badge, user menu |
| `DataTable.tsx` | Reusable table: sorting, pagination, search, bulk actions |
| `StatCard.tsx` | Metric card with number, label, trend indicator |
| `ImpersonationBanner.tsx` | Fixed banner during impersonation |
| `ConfirmDialog.tsx` | Confirmation modal for destructive actions |
| `QueueHealthCard.tsx` | Pending/active/failed counts with color coding |
| `StatusBadge.tsx` | Colored badge for statuses (post, token, plan) |

### Design Patterns

- Reuses existing shadcn/ui primitives (Card, Button, Badge, Dialog, Table, Sheet, etc.)
- Dark sidebar + light content area for visual distinction from user dashboard
- Tables are the primary UI — most pages are filterable data tables with row actions
- Detail views use Sheet (slide-over panel) to maintain table context
- No new dependencies beyond what exists

## Schema Changes Summary

```prisma
// Add to User model
isSuperAdmin Boolean  @default(false)
isBanned     Boolean  @default(false)
deletedAt    DateTime?

// Modify AuditLog model — make organizationId nullable for admin-level actions
organizationId String?  // was: String (required)
// Update the relation: organization Organization? @relation(...)  // add ? to make optional
```

The `AuditLog.organizationId` must become nullable because admin-level actions (e.g., `admin.user.superadmin_toggled`, `admin.user.deleted`) are not scoped to any organization. The existing `packages/api/src/lib/audit.ts` helper must be updated to accept `organizationId` as optional.

## Audit Actions Added

All admin mutations log with `admin.*` prefix:

- `admin.user.superadmin_toggled`
- `admin.user.banned` / `admin.user.unbanned`
- `admin.user.deleted`
- `admin.user.impersonated`
- `admin.org.plan_changed`
- `admin.org.deleted`
- `admin.post.retried`
- `admin.channel.disconnected`
- `admin.channel.token_refreshed`
- `admin.agent.toggled`
- `admin.agent.deleted`
- `admin.media.deleted`
- `admin.queue.job_retried`
- `admin.queue.job_deleted`

## Files to Create/Modify

| Action | File |
|--------|------|
| Modify | `packages/db/prisma/schema.prisma` — Add isSuperAdmin, isBanned, deletedAt to User; make AuditLog.organizationId nullable |
| Modify | `packages/auth/src/config.ts` — Extend JWT/session with isSuperAdmin |
| Modify | `packages/api/src/trpc.ts` — Add superAdminProcedure, impersonation check, isBanned check |
| Modify | `packages/api/src/lib/audit.ts` — Make organizationId optional |
| Modify | `packages/api/package.json` — Add @postautomation/queue dependency |
| Create | `packages/api/src/routers/admin.router.ts` — All admin sub-routers |
| Modify | `packages/api/src/root.ts` — Register admin router |
| Modify | `apps/web/middleware.ts` — Guard /admin routes using getToken() from next-auth/jwt |
| Modify | `apps/web/app/api/trpc/[trpc]/route.ts` — Pass impersonation cookie to tRPC context |
| Create | `apps/web/app/admin/layout.tsx` — Admin layout with sidebar |
| Create | `apps/web/app/admin/login/page.tsx` — Admin login page |
| Create | `apps/web/app/admin/page.tsx` — Overview dashboard |
| Create | `apps/web/app/admin/users/page.tsx` — Users management |
| Create | `apps/web/app/admin/orgs/page.tsx` — Organizations management |
| Create | `apps/web/app/admin/posts/page.tsx` — Posts management |
| Create | `apps/web/app/admin/channels/page.tsx` — Channels management |
| Create | `apps/web/app/admin/agents/page.tsx` — Agents management |
| Create | `apps/web/app/admin/media/page.tsx` — Media management |
| Create | `apps/web/app/admin/queues/page.tsx` — Queue dashboard |
| Create | `apps/web/app/admin/audit/page.tsx` — Audit logs |
| Create | `apps/web/components/admin/AdminSidebar.tsx` |
| Create | `apps/web/components/admin/AdminHeader.tsx` |
| Create | `apps/web/components/admin/DataTable.tsx` |
| Create | `apps/web/components/admin/StatCard.tsx` |
| Create | `apps/web/components/admin/ImpersonationBanner.tsx` |
| Create | `apps/web/components/admin/ConfirmDialog.tsx` |
| Create | `apps/web/components/admin/QueueHealthCard.tsx` |
| Create | `apps/web/components/admin/StatusBadge.tsx` |
