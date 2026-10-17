/**
 * Subscribe our Meta app to a Facebook Page (2026-10-17).
 *
 * Instagram webhooks (`mentions`, `comments`) are delivered only when "the Page
 * connected to the app user's account has Page subscriptions enabled" — Meta:
 * POST /{page-id}/subscribed_apps with the Page's access token, the
 * `pages_manage_metadata` + `pages_show_list` permissions, and a person who can
 * perform CREATE_CONTENT / MANAGE / MODERATE on the Page. Any Page field turns
 * subscriptions on; we use `name`, which almost never changes, so the Page does
 * not start streaming feed events at the web container.
 *
 * ⚠️ Read before write: a POST with `subscribed_fields` REPLACES the field list
 * our app has on that Page. If the app is already subscribed (with whatever
 * fields someone configured), we leave it exactly as it is.
 *
 * NEVER throws — it runs after a successful connect, and a failure here must
 * never undo or fail that connect.
 */
import { fetchT } from "./fetch-timeout";
import { GRAPH_OBJECT_ID_RE } from "./instagram-comments";

export const PAGE_SUBSCRIPTION_FIELD = "name";
const GRAPH = "https://graph.facebook.com/v18.0";
const TIMEOUT_MS = 15_000;

export type PageSubscriptionStatus = "subscribed" | "already" | "missing_permission" | "failed";

export interface PageSubscriptionResult {
  pageId: string;
  status: PageSubscriptionStatus;
  /** Short, token-free reason for a failure (Meta's error code/subcode). */
  reason?: string;
}

/** `(#200)`/`(#10)` family, `#283`, or a "permission" message ⇒ the grant is missing. */
function isPermissionError(err: any): boolean {
  const code = Number(err?.code);
  if (code === 10 || code === 283 || (code >= 200 && code <= 299)) return true;
  return /permission/i.test(String(err?.message ?? ""));
}

function reasonOf(err: any, status: number): string {
  const code = err?.code != null ? `#${err.code}` : `HTTP ${status}`;
  return err?.error_subcode != null ? `${code}/${err.error_subcode}` : code;
}

export async function ensurePageSubscribed(input: {
  pageId: string;
  pageAccessToken: string;
  appId: string;
}): Promise<PageSubscriptionResult> {
  const { pageId, pageAccessToken, appId } = input;
  try {
    if (!GRAPH_OBJECT_ID_RE.test(pageId) || !pageAccessToken || !appId) {
      return { pageId, status: "failed", reason: "invalid input" };
    }
    const base = `${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`;

    // 1. Is our app already subscribed? Then touch nothing.
    const listParams = new URLSearchParams({ fields: "id,subscribed_fields", access_token: pageAccessToken });
    const listRes = await fetchT(`${base}?${listParams.toString()}`, {}, TIMEOUT_MS);
    const list: any = await listRes.json().catch(() => null);
    if (!listRes.ok) {
      const err = list?.error;
      return isPermissionError(err)
        ? { pageId, status: "missing_permission", reason: reasonOf(err, listRes.status) }
        : { pageId, status: "failed", reason: reasonOf(err, listRes.status) };
    }
    const apps: any[] = Array.isArray(list?.data) ? list.data : [];
    if (apps.some((a) => String(a?.id) === String(appId))) return { pageId, status: "already" };

    // 2. Subscribe with one quiet field.
    const res = await fetchT(base, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ subscribed_fields: PAGE_SUBSCRIPTION_FIELD, access_token: pageAccessToken }).toString(),
    }, TIMEOUT_MS);
    const data: any = await res.json().catch(() => null);
    if (res.ok && data?.success === true) return { pageId, status: "subscribed" };
    const err = data?.error;
    if (isPermissionError(err)) return { pageId, status: "missing_permission", reason: reasonOf(err, res.status) };
    return { pageId, status: "failed", reason: reasonOf(err, res.status) };
  } catch (err: any) {
    return { pageId, status: "failed", reason: err?.name === "TimeoutError" ? "timeout" : "request did not complete" };
  }
}

/** One Page from a consent's `me/accounts`, with the IG account linked to it (if any). */
export interface LinkedPage {
  pageId: string;
  pageAccessToken: string;
  igUserId: string | null;
}

const LIST_MAX_PAGES = 10;

/**
 * List the Pages a Facebook USER token can manage, with each Page's token and
 * linked Instagram account (2026-10-17, for the Page-subscription backfill: an
 * IG channel stores the user token, not its Page's). One call per 100 Pages.
 *
 * NEVER throws. `ok: false` means the listing could not be read (usually a dead
 * token); a partial listing after a later page fails is still `ok: false`, so a
 * caller never reads "not in the list" from an incomplete answer.
 */
export async function listLinkedPages(
  userAccessToken: string
): Promise<{ ok: boolean; pages: LinkedPage[]; reason?: string }> {
  const pages: LinkedPage[] = [];
  try {
    if (!userAccessToken) return { ok: false, pages, reason: "no token" };
    const params = new URLSearchParams({
      fields: "id,access_token,instagram_business_account{id}",
      limit: "100",
      access_token: userAccessToken,
    });
    let url: string | null = `${GRAPH}/me/accounts?${params.toString()}`;
    for (let n = 0; url; n++) {
      if (n >= LIST_MAX_PAGES) return { ok: false, pages, reason: "too many Pages" };
      const res = await fetchT(url, {}, TIMEOUT_MS);
      const body: any = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, pages, reason: reasonOf(body?.error, res.status) };
      for (const p of Array.isArray(body?.data) ? body.data : []) {
        if (typeof p?.id !== "string" || !GRAPH_OBJECT_ID_RE.test(p.id) || typeof p?.access_token !== "string") continue;
        const ig = p.instagram_business_account?.id;
        pages.push({ pageId: p.id, pageAccessToken: p.access_token, igUserId: typeof ig === "string" ? ig : null });
      }
      const next = body?.paging?.next;
      url = typeof next === "string" && next.startsWith(`${GRAPH}/`) ? next : null;
    }
    return { ok: true, pages };
  } catch (err: any) {
    return { ok: false, pages, reason: err?.name === "TimeoutError" ? "timeout" : "request did not complete" };
  }
}
