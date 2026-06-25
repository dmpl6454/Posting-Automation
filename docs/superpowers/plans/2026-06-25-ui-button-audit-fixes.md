# UI Button Audit — Fix Plan (2026-06-25)

Branch: `fix/ui-button-audit-2026-06-25`. Source audit: 60-agent workflow, 616 buttons, 46 confirmed defects (2 HIGH, 16 MED, 28 LOW; 1 refuted).

**Method:** Sonnet codes each unit, Opus reviews, adversarial-verify the core-function fixes. Verify gate per CLAUDE.md: `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (exit 0) + `pnpm --filter @postautomation/api test`, NOT just tsc.

The 46 collapse into **9 fix-units** because 36 silent-fails share one root cause.

---

## UNIT 1 — Global mutation error feedback (covers 36 silent-fails) — HIGHEST LEVERAGE
**Root cause:** `apps/web/lib/trpc/react.tsx` builds the `QueryClient` with only `defaultOptions.queries` — there is NO `MutationCache` with a global `onError`. So any mutation that omits its own `onError` rejects with zero user feedback.

**Fix:** Add a `MutationCache({ onError })` to the `QueryClient`. The handler calls the standalone imperative `toast()` (from `apps/web/hooks/use-toast.ts`, module-level memoryState — works outside React) with `humanizeError(err)` (from `apps/web/lib/errors.ts`), variant `destructive`.

**Why additive / safe:** TanStack `MutationCache.onError` fires only as the fallback — any mutation with its own `onError` (bulkDisconnect, createPost, rss, autopilot/page) keeps winning. No per-site edits needed for the 36.

**Covers:** all 36 silent-fail rows (RepurposeTab ×9, channels ×3, autopilot review ×4, monitoring ×4, campaigns ×3, notification-bell ×2, settings ×2, + approvals, brand-leads(538), listening, newsgrid Save-Profile, campaigns(226/436), autopilot agents/accounts).
**Note:** "Copy Report for Claude" (monitoring:116) is a clipboard write, not a tRPC mutation — handle separately in Unit 9 (wrap in try/catch + toast).
**Test:** `apps/web/lib/trpc/mutation-error.test.ts` — assert the MutationCache onError calls toast with humanized message; assert a mutation WITH its own onError is not double-toasted.
**Verify:** web build green.

## UNIT 2 — HIGH: Admin impersonation JWT field mismatch
`packages/api/src/routers/admin/users.router.ts:179` signs `impersonatedUserId`; `packages/api/src/trpc.ts:73` reads `payload.targetUserId` (signed nowhere). Fix: read `payload.impersonatedUserId` in trpc.ts. (One-word field rename — align reader to signer; signer field name is also used in the cookie/banner naming.)
**Test:** `packages/api/src/__tests__/impersonation-token.test.ts` — sign with the router's payload, assert trpc reads the same field → resolves the impersonated user.
**Verify:** api test green.

## UNIT 3 — HIGH: Duplicate post on action re-click (content-agent/[id] surface)
`apps/web/hooks/use-chat-stream.ts:183` omits `clientActionId`. The stream route already stamps `action.idempotencyKey` (`app/api/chat/stream/route.ts:277/296`). Fix: (a) thread `clientActionId: action.idempotencyKey` into the `executeActionMutation.mutateAsync` call; (b) add a persistent executed-action lock in MessageBubble (mirror `super-agent/page.tsx` `executedActionIds` + disable on it), so re-click is blocked client-side too.
**Test:** logic test that the payload includes clientActionId; backend dedupe test already exists for isActionAlreadyExecuted.
**Verify:** web build + api test green.

## UNIT 4 — MED mis-wired: ContentActionBar "Post Now" always 400s
`components/chat/MessageBubble.tsx:124` flips a `generate_content` action (payload has no channelIds) to `publish_now`, which then throws BAD_REQUEST. Fix: the "Post Now" on a draft must collect channelIds first — route it through the same channel-selection path the other publish actions use (merge selected channels), OR disable Post-Now until channels are chosen with a tooltip. Decide during impl by reading the surrounding draft UI.
**Verify:** web build green; manual trace.

## UNIT 5 — MED mis-wired: NewsGrid scheduled Publish 400s
`app/dashboard/newsgrid/page.tsx:597` sends raw datetime-local `"YYYY-MM-DDTHH:mm"`; backend wants `z.string().datetime()` (empirically rejects naive string in zod@3.25.76). Fix: `scheduleTime: scheduleMap[r.channelId] ? new Date(scheduleMap[r.channelId]).toISOString() : null` (mirror ComposeTab:548 / BulkTab:122).
**Verify:** web build green; the existing onError toast already surfaces failures.

## UNIT 6 — MED dead-handler: Admin "Load more"
`components/admin/DataTable.tsx:110` binds `onClick={onLoadMore}` but no admin page passes `onLoadMore`. Fix: convert the 7 paginated admin pages (users/orgs/posts/channels/agents/audit/media) to `useInfiniteQuery` + `fetchNextPage`, passing `onLoadMore={fetchNextPage}` and `hasMore={hasNextPage}` — mirror the Monitoring page's prior Load-more fix.
**Verify:** web build green per page.

## UNIT 7 — MED broken-nav: Webhooks detail page unreachable
`app/dashboard/settings/webhooks/page.tsx:127` list row has no link to `/dashboard/settings/webhooks/[id]` (the fully-built delivery-history page). Fix: wrap the row (or add a "Deliveries" button) in a `Link`/`router.push` to `/dashboard/settings/webhooks/${wh.id}`. Keep the Trash delete from triggering nav (stopPropagation).
**Verify:** web build green.

## UNIT 8 — MED broken-nav: Login drops `?invite=<token>`
`app/(auth)/login/page.tsx:18` reads only `?callbackUrl`; invite page sends `?invite=<token>`. Fix: read `searchParams.get("invite")`; if present, set post-login target to `/invite/<token>` (for email login, OTP, and Google). Also fix register/page.tsx the same way (E2E-audit H10 overlap).
**Verify:** web build green.

## UNIT 9 — LOW behavioral fixes (not silent-fail)
- **autopilot group-delete confirm()** (`accounts/page.tsx:185`): add `confirm()` like agent-delete (AP-4).
- **brand-leads "Approve All Today (N)" count** (`brand-leads/page.tsx:512`): count today-only pending so N == acted scope (filter `createdAt >= today` to match approveAll).
- **Undo/Redo reactive disabled** (`media-editor/hooks/useEditorHistory.ts:63`): back canUndo/canRedo with `useState` bumped in saveState/undo/redo so the disabled prop is reactive.
- **monitoring "Copy Report for Claude"** (`monitoring/page.tsx:116`): wrap clipboard write in try/catch + toast (covered by Unit 1 only if it's a mutation — it's clipboard, so explicit).
**Verify:** web build green; Undo/Redo manual.

---

## Sequencing
1. Unit 1 first (unblocks 36, lowest risk, pure addition).
2. Units 2,3 (HIGH) next — security + data-integrity.
3. Units 4–8 (MED core-function).
4. Unit 9 (LOW behavioral).
Each unit: Sonnet implements → Opus reviews → build/test gate. Commit per unit.
