# Campaigns Honesty Relabel + Capability Copy + Content Studio Style-Ref Copy — Design

**Date:** 2026-06-29
**Status:** APPROVED (brainstorming lock confirmed)
**Author:** Claude (design facilitator) + tabish@dashmani.com

## Context

An end-to-end verification of Brand Outreach, Campaigns, Super Agent, and Content Studio
found two "truth in UI" defects:

1. **Campaigns** presents itself as an operational campaign engine — `ACTIVE/PAUSED` status
   with play/pause controls, and a dashboard card saying "Group posts into a campaign" — but it
   schedules nothing and groups no posts. It is actually a brand/influencer/content **monitoring**
   organizer. The `CampaignPost` table is never populated (zero `.create()` repo-wide), so the
   campaign-analytics-sync worker (which IS alive and whose queue names match) always aggregates
   an empty set. The detail page never even reads those phantom metrics.
2. **Content Studio** style-reference helper copy claims it matches the reference's *layout,
   alignment, logo position, headline treatment* — but the default (mimicry-OFF) path only applies
   colors/theme/accent and pre-selects one of 4 fixed templates. Layout recreation happens ONLY
   when the opt-in "Recreate layout" (Gemini img2img) toggle is ON.

A third request — a **cost-breakdown page** (per model / per API) — was **deferred** by the user.

## Understanding Summary

- Scope = two truth-in-UI fixes (Campaigns relabel + Content Studio copy) + capability copy for
  Campaigns and Brand Outreach. Cost page deferred.
- Campaigns becomes an honest **monitoring** tool, NOT a posting/scheduling engine.
- The fake ACTIVE/PAUSED play-pause is replaced by a REAL "Monitoring on/off" toggle that gates
  actual background work.
- Misleading copy is corrected; capability copy is added so users know what each feature can/can't do.
- Honesty bar: no control claims an effect the backend doesn't deliver; nothing working is hidden.

## Assumptions (confirmed)

- **A1:** Monitoring toggle flips `BrandTracker.isActive` on the campaign's trackers — reuses the
  field the brand-content-sync cron already reads (`brandTracker.findMany({ where: { isActive: true } })`).
  No schema migration.
- **A2:** Keep the `Campaign.status` column (harmless); UI stops surfacing ACTIVE/PAUSED/play-pause.
  `campaign.create` default `status:"ACTIVE"` stays (now invisible).
- **A3:** Do NOT touch campaign-analytics-sync worker or `CampaignPost` — remain dormant; no UI claim
  about per-campaign performance metrics.
- **A4:** Detail-page stat cards (Brands Tracked / Content Found / Influencers Found) stay — real counts.
- **A5:** Verify via `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (exit 0) +
  `pnpm --filter @postautomation/api test`.
- **A6:** New branch + PR (not direct to main).
- **Q1:** Zero-tracker campaign → Monitoring toggle disabled, "Add a brand to monitor."
- **Q2:** Nav stays "Campaigns"; dashboard card title becomes "Brand Campaigns"; only sub-copy fixed.

## Final Design

### 1. Campaigns backend (`packages/api/src/routers/campaign.router.ts`)
- New `setMonitoring` orgProcedure: `{ id, enabled }` → `brandTracker.updateMany({ where:{ campaignId:id,
  organizationId: ctx.organizationId }, data:{ isActive: enabled } })`; returns `{ count }`. Org-scoped (IDOR-safe).
- Extend `list` + `byId` to include active/total tracker counts (`_count` or computed) so the UI can show
  "N of M brands monitored" and derive the toggle.
- Mixed-state rule: campaign toggle ON if `activeTrackerCount > 0`; clicking sets ALL trackers to the new
  value; per-tracker toggles remain independent; zero trackers → disabled.

### 2. Campaigns frontend
- **List (`apps/web/app/dashboard/campaigns/page.tsx`):** remove play/pause/archive buttons (~435-444) +
  status badge (~411); add per-row Monitoring `Switch` + "N of M brands" caption wired to `setMonitoring`;
  replace the `status==="ACTIVE"` top stat (~174) with "Brands monitored"; delete now-dead `statusColors`
  + `Pause`/`Play` imports.
- **Detail (`apps/web/app/dashboard/campaigns/[id]/page.tsx`):** remove status badge (~139); add header
  Monitoring toggle + honest descriptor "Monitoring fetches recent posts from these brands every ~6 hours";
  keep the 3 real stat cards; delete dead `statusColors`.

### 3. Capability copy
- **Campaigns dashboard card (`apps/web/app/dashboard/page.tsx:109-110`):** title "Brand Campaigns";
  desc "Group brands & influencers to monitor, and discover related creators. Tracks competitors' content —
  does not schedule your posts."
- **Campaigns list header subtitle:** "Monitor brands and competitors for new content, and discover
  influencers. Monitoring fetches their recent posts every ~6 hours."
- **Campaigns empty state:** "Create a campaign to group the brands and influencers you want to monitor."
- **Brand Outreach header subtitle (`apps/web/app/dashboard/brand-leads/page.tsx`):** "Detects
  brand-partnership leads, drafts outreach with AI, and sends via email & X/Twitter DM automatically.
  LinkedIn & Instagram DMs are prepared for you to copy-send manually. Replies aren't tracked — log
  outcomes here."

### 4. Content Studio style-reference copy (`apps/web/components/content-agent/RepurposeTab.tsx`)
- OFF/default helper: "We read your reference's colors, theme & accent and pre-select the closest layout
  template. Turn on 'Recreate layout' below to rebuild its actual structure."
- "Recreate layout" toggle: label "Recreate reference layout (AI)"; helper "Rebuilds the reference's
  structure — headline placement, logo position, alignment — via AI image-to-image. Off = colors & theme only."
- Keep the honest `mimicryEngine` result chip.

### 5. Verification & rollout
- Branch + PR; web build exit 0; api tests (+ a new org-scope/IDOR test for `setMonitoring`).
- No migration, no worker change, no analytics/CampaignPost touch.

## Decision Log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| D1 | Campaigns = honest monitoring tool | Full engine; bare relabel | User chose "make honest"; full engine = phantom CampaignPost build (out of scope) |
| D2 | Toggle flips tracker `isActive` | New `monitoringEnabled` col + cron change | Reuses field cron already reads; zero migration |
| D3 | Toggle ON if any tracker active; bulk-sets all; per-tracker independent | Strict all-on/off boolean | Honest about mixed state ("2 of 3 monitored") |
| D4 | Keep nav "Campaigns"; card "Brand Campaigns"; fix sub-copy | Rename everywhere | Minimal churn |
| D5 | One tight first-contact capability line per feature | Disclaimer walls; nothing | Truth without clutter |
| D6 | Content Studio: make layout claim conditional on mimicry toggle | Delete claim | Keeps real capability tied to the switch that delivers it |
| D7 | Cost-breakdown page deferred | Hybrid/official/self-metered | User deferred; tradeoff preserved below |
| D8 | Dormant `status`/analytics/CampaignPost untouched | Remove | Out of scope; harmless; lower risk |

## Deferred: Cost-Breakdown Page (design notes for later)

Core accuracy tradeoff captured for when this resumes:
- **Official billing APIs** = authoritative dollars, but account-level (no per-org/per-feature/per-model
  attribution for most providers), often T+1 delayed.
- **Self-metered** (tokens/calls × maintained price table) = fully granular + real-time, but it's an
  estimate; accuracy depends on capturing every call + current prices.
- **Recommended:** hybrid — self-meter for granularity, reconcile against official billing API totals,
  show the delta. Providers in play: OpenAI (gpt-image-1, text), Anthropic, Gemini/Veo3, fal.ai (Seedance),
  plus non-AI (Resend, Twitter, Hunter, SMTP).
