/**
 * Classifies why a Meta (Facebook / Instagram) insights read came back short, so
 * the pipeline can tell "the owner must reconnect to grant a scope" apart from
 * "this post genuinely has zero engagement". Both look like `0` in the stored
 * metrics, and conflating them is the root of the long-standing complaint that
 * Insights shows confident zeros for channels whose tokens are dead.
 *
 * Pure + testable — no fetch, no I/O. See meta-insight-diagnosis.test.ts.
 *
 * ── Live-verified behavior (2026-08-06, prod tokens, real posts) ──────────────
 * Probed the SAME calls with a token that HAS the newly-approved scopes and one
 * that does not:
 *
 *   FB feed /insights?metric=post_clicks,…   without read_insights → HTTP 200 + {"data":[]}
 *                                            with    read_insights → HTTP 200 + 4 rows
 *   FB     /video_insights                   without read_insights → #200 "read_insights permission missing"
 *   FB     ?fields=reactions.summary(true)   without pages_read_user_content
 *                                                                  → #10 "requires the 'pages_read_user_content' permission"
 *
 * The first line is the dangerous one: a missing scope on the FB post-insights
 * edge is a SILENT EMPTY, not an error. It therefore CANNOT be detected from the
 * HTTP status — only from "the response succeeded but carried zero rows for a
 * metric that always returns a row when permitted". `post_clicks` and
 * `post_reactions_by_type_total` both return a row even on a zero-engagement
 * post (verified), which makes them reliable sentinels.
 *
 * ⚠️ Do NOT treat Meta error #100 as a permission problem. #100 ("The value must
 * be a valid insights metric") means the metric NAME is invalid — verified to be
 * returned for all nine `post_impressions*` variants EVEN WITH read_insights
 * granted, because Meta deleted those metrics at the platform level. Mapping
 * #100 to `missing_scope` would tell users to reconnect for data that no
 * permission can ever return.
 */
import type { AnalyticsDegradation } from "../abstract/social.types";

/** Meta error codes that mean the token itself is no longer usable. */
const TOKEN_INVALID_CODES = new Set([190, 102, 463, 467]);

/**
 * Meta subcode 492, returned alongside #190, is NOT a dead token — it is
 * "the user must be an administrator, editor, or moderator of the page in order
 * to impersonate it". LIVE-VERIFIED on prod 2026-08-12: the backing user token
 * was `is_valid: true`, carried all 12 scopes, had a data-access window 3 months
 * out, and could read 72 OTHER pages — including 33 in the same Business as the
 * failing one. So neither the credential nor a scope nor the 90-day cliff was at
 * fault; access to that ONE page was gone.
 *
 * Two causes are indistinguishable through the API (`me/assigned_pages` → #10,
 * `{page}/roles` needs the very page token we cannot mint): the page was left
 * unticked in a later consent, or the person's Page role changed. Both are fixed
 * by the same action — reconnect and explicitly tick the page — so the copy
 * names that action and states the fallback, rather than guessing a cause.
 */
const PAGE_ACCESS_LOST_SUBCODE = 492;

/** Meta error codes that mean a permission/scope is missing. */
const MISSING_SCOPE_CODES = new Set([10, 200, 3, 803]);

export interface MetaErrorLike {
  code?: number;
  error_subcode?: number;
  message?: string;
  type?: string;
}

/**
 * Pulls the scope names Meta itself named in an error message. Meta phrases this
 * several ways, all of which appear in real responses:
 *   "(#10) This endpoint requires the 'pages_read_user_content' permission …"
 *   "(#200) read_insights permission missing"
 *   "requires pages_read_engagement permission"
 * Only returns names that look like Meta scopes, so arbitrary message text can
 * never end up presented to the user as a scope to grant.
 */
export function extractMissingScopes(message: string | undefined): string[] {
  if (!message) return [];
  const found = new Set<string>();

  // 'quoted_scope' form
  for (const m of message.matchAll(/['"`]([a-z_]{4,60})['"`]\s*permission/gi)) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  // bare `scope_name permission` form (covers both "X permission missing" and
  // "requires X permission")
  for (const m of message.matchAll(/\b([a-z][a-z_]{3,60})\s+permission\b/gi)) {
    if (m[1]) found.add(m[1].toLowerCase());
  }

  // Keep only plausible Meta scope names: snake_case with a known prefix.
  const PREFIXES = ["pages_", "read_", "instagram_", "business_", "ads_", "catalog_", "public_"];
  return [...found].filter((s) => s.includes("_") && PREFIXES.some((p) => s.startsWith(p)));
}

/**
 * Classify a Graph API error body. Returns undefined when the error is NOT a
 * capability problem (a rate limit, an invalid metric name, a transient 5xx) —
 * those must not be reported to the user as "reconnect required".
 */
export function diagnoseMetaError(err: MetaErrorLike | undefined | null): AnalyticsDegradation | undefined {
  if (!err) return undefined;
  const code = Number(err.code);
  const message = String(err.message ?? "");

  // Checked BEFORE the generic token branch: 492 arrives *with* code 190, so the
  // broad TOKEN_INVALID_CODES test would otherwise swallow it and report the
  // misleading "your access token was rejected".
  if (Number(err.error_subcode) === PAGE_ACCESS_LOST_SUBCODE) {
    return {
      reason: "page_access_lost",
      detail:
        "This platform account is no longer accessible to the connected profile. " +
        "Reconnect and make sure it is ticked in the permission screen — if it is not listed, " +
        "its access was changed on the platform.",
    };
  }

  if (TOKEN_INVALID_CODES.has(code)) {
    return {
      reason: "token_invalid",
      detail: "The platform rejected the stored access token. Reconnect this channel.",
    };
  }

  if (MISSING_SCOPE_CODES.has(code)) {
    const missingScopes = extractMissingScopes(message);
    return {
      reason: "missing_scope",
      ...(missingScopes.length ? { missingScopes } : {}),
      detail: missingScopes.length
        ? `Reconnect to grant: ${missingScopes.join(", ")}.`
        : "The platform requires an additional permission. Reconnect this channel.",
    };
  }

  // #4 rate limit, #100 invalid-metric-name, 5xx, anything else: not a
  // capability problem the user can act on. Deliberately no degradation.
  return undefined;
}

/**
 * The silent-empty case: the insights call SUCCEEDED but returned zero rows for a
 * metric set containing a sentinel that always returns a row when permitted.
 *
 * @param rowCount   number of metric rows Meta returned
 * @param hadSentinel whether the request included an always-present metric
 * @param scope      the scope to name in the reconnect prompt
 */
export function diagnoseEmptyInsights(
  rowCount: number,
  hadSentinel: boolean,
  scope: string
): AnalyticsDegradation | undefined {
  if (rowCount > 0 || !hadSentinel) return undefined;
  return {
    reason: "missing_scope",
    missingScopes: [scope],
    detail: `Reconnect to grant: ${scope}.`,
  };
}

/**
 * Picks the degradation worth reporting when several calls degraded differently.
 * A dead token is strictly more actionable than a missing scope, which is more
 * actionable than an unattributed empty.
 */
export function worstDegradation(
  ...candidates: Array<AnalyticsDegradation | undefined>
): AnalyticsDegradation | undefined {
  // `page_access_lost` outranks `token_invalid`: both mean "reconnect", but it is
  // strictly the more specific diagnosis, and a channel can produce both (one
  // call surfaces the bare #190, another the #190/492). The more precise message
  // must win, otherwise the specific finding is silently discarded.
  const RANK: Record<string, number> = {
    page_access_lost: 4,
    token_invalid: 3,
    missing_scope: 2,
    no_data: 1,
  };
  let best: AnalyticsDegradation | undefined;
  for (const c of candidates) {
    if (!c) continue;
    if (!best || (RANK[c.reason] ?? 0) > (RANK[best.reason] ?? 0)) best = c;
    else if (
      (RANK[c.reason] ?? 0) === (RANK[best.reason] ?? 0) &&
      c.missingScopes?.length &&
      best.missingScopes?.length
    ) {
      // Same severity → union the named scopes so one prompt covers both calls.
      best = {
        ...best,
        missingScopes: [...new Set([...best.missingScopes, ...c.missingScopes])].sort(),
      };
      best.detail = `Reconnect to grant: ${best.missingScopes!.join(", ")}.`;
    }
  }
  return best;
}
