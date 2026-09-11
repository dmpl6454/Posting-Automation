/**
 * Registry of the Meta (Facebook/Instagram) OAuth apps this deployment can use.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A Meta access token is bound to the APP THAT MINTED IT. `Channel.accessToken`
 * therefore cannot be interpreted without knowing which app issued it, and the
 * moment a second Meta app exists, every `process.env.FACEBOOK_CLIENT_SECRET`
 * read becomes a coin flip. This module is the ONE place that turns
 * "(platform, metaAppId)" into a credential pair.
 *
 * ── The rules, each of which exists because breaking it is a real incident ───
 *
 * 1. NULL/absent `metaAppId` means the LEGACY app — the one whose credentials
 *    live in `FACEBOOK_CLIENT_ID` / `INSTAGRAM_CLIENT_ID`. Every pre-existing
 *    Channel row has NULL here, so the legacy path must be byte-identical to
 *    the pre-registry `process.env[`${PLATFORM}_CLIENT_ID`]` read. Absent
 *    config always means pre-existing behaviour.
 *
 * 2. FACEBOOK AND INSTAGRAM ARE SEPARATE CREDENTIAL PAIRS ON THE LEGACY PATH.
 *    `FACEBOOK_CLIENT_ID/SECRET` and `INSTAGRAM_CLIENT_ID/SECRET` are four
 *    distinct env keys (docker-compose.prod.yml web :157/:167, worker
 *    :220/:226). They hold the same value today, but every existing consumer
 *    reads its OWN platform's pair. Collapsing them into one "app A" entry
 *    would silently repoint Instagram the day they diverge — which is why
 *    `resolveMetaCredentials` takes a `platform`.
 *
 * 3. FAIL CLOSED ON EMPTY STRING. `docker-compose.prod.yml` uses an explicit
 *    `environment:` allowlist, so a key present in `.env.prod` but missing
 *    from compose arrives as `""` — not undefined. An app registers ONLY when
 *    BOTH its id and secret are non-empty. This is not cosmetic:
 *    `crypto.createHmac("sha256", "")` yields a valid, attacker-computable
 *    digest, so an empty secret reaching the webhook verifier is an auth
 *    bypass rather than a disabled feature.
 *
 * 4. READ ENV AT CALL TIME, NEVER AT MODULE LOAD. The webhook routes used to
 *    do `const APP_SECRET = process.env.FACEBOOK_CLIENT_SECRET` at module
 *    scope, which freezes whatever was set when the module was first imported.
 *    Every export here re-reads `process.env`.
 *
 * 5. NEVER THROW. These resolve inside the publish worker's retry path; a throw
 *    there would turn a config problem into a failed post. Callers get `null`
 *    and decide.
 *
 * There is deliberately NO global "default app" switch. App selection is
 * per-organization (`Organization.metaAppId`). A global default would apply to
 * every org at once, and because `getDefaultScopes` is keyed on PLATFORM rather
 * than app, pointing orgs at an unapproved app makes their users connect
 * successfully and then fail to publish. Moving one org at a time is what makes
 * both App Review (route the reviewer's workspace) and future load-splitting
 * safe.
 */

/** The Meta platforms that share this registry. */
export type MetaPlatform = "FACEBOOK" | "INSTAGRAM";

const META_PLATFORMS: readonly string[] = ["FACEBOOK", "INSTAGRAM"];

/**
 * Type guard so callers can branch on "is this a Meta platform?" and leave
 * every other platform's `${PREFIX}_CLIENT_ID` read untouched. Narrowing here
 * rather than at each call site is what keeps LinkedIn/YouTube/Reddit/TikTok/
 * Snapchat byte-identical.
 */
export function isMetaPlatform(platform: string): platform is MetaPlatform {
  return META_PLATFORMS.includes(platform);
}

/**
 * Extra (non-legacy) app slots. Deliberately a FIXED list rather than a scan of
 * `process.env`: every key here must also be added to BOTH the web and worker
 * `environment:` blocks in docker-compose.prod.yml, and a finite list is what
 * makes that checkable.
 */
const EXTRA_APP_SLOTS = ["META_APP_2", "META_APP_3"] as const;

export interface MetaAppCredentials {
  /** Meta's numeric App ID, as a string. */
  appId: string;
  clientId: string;
  clientSecret: string;
  /** True when sourced from the legacy per-platform env pair (metaAppId NULL). */
  legacy: boolean;
}

/** Trim and treat empty as absent. See rule 3. */
function clean(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v.length > 0 ? v : null;
}

/**
 * The legacy credential pair for a platform — exactly the read every call site
 * performed before this registry existed.
 */
export function legacyMetaCredentials(platform: MetaPlatform): MetaAppCredentials | null {
  const clientId = clean(process.env[`${platform}_CLIENT_ID`]);
  const clientSecret = clean(process.env[`${platform}_CLIENT_SECRET`]);
  if (!clientId || !clientSecret) return null;
  return { appId: clientId, clientId, clientSecret, legacy: true };
}

/**
 * Every non-legacy app that is fully configured. An app with only one half of
 * its pair set is NOT registered (rule 3).
 */
export function listExtraMetaApps(): MetaAppCredentials[] {
  const out: MetaAppCredentials[] = [];
  for (const slot of EXTRA_APP_SLOTS) {
    const appId = clean(process.env[`${slot}_ID`]);
    const clientSecret = clean(process.env[`${slot}_SECRET`]);
    if (!appId || !clientSecret) continue;
    if (out.some((a) => a.appId === appId)) continue; // same app in two slots
    out.push({ appId, clientId: appId, clientSecret, legacy: false });
  }
  return out;
}

/**
 * Resolve the credentials for a channel/org.
 *
 * @param platform  FACEBOOK or INSTAGRAM — selects the legacy pair (rule 2).
 * @param metaAppId `Channel.metaAppId` / `Organization.metaAppId`. NULL or
 *                  undefined ⇒ the legacy app (rule 1).
 * @returns null when the requested app is not configured. Callers MUST handle
 *          null rather than falling back to another app — publishing with the
 *          wrong app's secret is worse than a clean "not configured" error.
 */
export function resolveMetaCredentials(
  platform: MetaPlatform,
  metaAppId: string | null | undefined
): MetaAppCredentials | null {
  const wanted = clean(metaAppId ?? undefined);
  if (!wanted) return legacyMetaCredentials(platform);

  // An explicit id that happens to BE the legacy app resolves to the legacy
  // pair, so a row stamped with app A's id behaves like a NULL row.
  const legacy = legacyMetaCredentials(platform);
  if (legacy && legacy.appId === wanted) return legacy;

  // `find` over an array, deliberately NOT `wanted in someObject` — `in`
  // matches `__proto__`/`constructor`/`toString` and would return a garbage
  // entry for an attacker-influenced id. Same discipline as `safeHexColor`
  // and `resolveSuperTextFont`.
  return listExtraMetaApps().find((a) => a.appId === wanted) ?? null;
}

/**
 * Credentials for ANY platform, Meta-aware.
 *
 * Meta platforms resolve through the registry using the channel's `metaAppId`;
 * every other platform performs the identical `${PLATFORM}_CLIENT_ID` /
 * `_SECRET` read it always did — deliberately WITHOUT trimming, so non-Meta
 * behaviour is byte-identical.
 *
 * Returns null when unconfigured. Callers decide what to do; this never throws,
 * because several call sites are inside the publish worker's retry path where a
 * throw would turn a config problem into a failed post.
 */
export function resolvePlatformCredentials(
  platform: string,
  metaAppId: string | null | undefined
): { clientId: string; clientSecret: string } | null {
  if (isMetaPlatform(platform)) {
    const creds = resolveMetaCredentials(platform, metaAppId);
    return creds ? { clientId: creds.clientId, clientSecret: creds.clientSecret } : null;
  }
  const clientId = process.env[`${platform}_CLIENT_ID`];
  const clientSecret = process.env[`${platform}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Every DISTINCT Meta app configured on this deployment — the legacy pair(s)
 * plus any extra slots, deduped by APP ID.
 *
 * Note the different dedupe key from `listMetaWebhookSecrets`, which dedupes by
 * SECRET. Here the unit of interest is the app (Meta's rate-limit quota and
 * app-usage headers are per app), so two platforms sharing one app id must
 * collapse to a single entry or a health probe would double-count it.
 */
export function listAllMetaApps(): MetaAppCredentials[] {
  const out: MetaAppCredentials[] = [];
  const seen = new Set<string>();
  const push = (cred: MetaAppCredentials | null) => {
    if (!cred || seen.has(cred.appId)) return;
    seen.add(cred.appId);
    out.push(cred);
  };
  push(legacyMetaCredentials("FACEBOOK"));
  push(legacyMetaCredentials("INSTAGRAM"));
  for (const app of listExtraMetaApps()) push(app);
  return out;
}

/** True when this deployment has any non-legacy Meta app configured. */
export function hasMultipleMetaApps(): boolean {
  return listExtraMetaApps().length > 0;
}

/**
 * Is `metaAppId` a usable app for this platform? Used to validate operator
 * input before it is written to `Organization.metaAppId` — an unvalidated id
 * would strand every future connect for that org on a null resolution.
 */
export function isKnownMetaAppId(platform: MetaPlatform, metaAppId: string): boolean {
  return resolveMetaCredentials(platform, metaAppId) !== null;
}

/**
 * Every DISTINCT app secret that could legitimately sign an inbound Meta
 * webhook, newest-slot-last, each tagged with the app it belongs to.
 *
 * Consumers: `verifyMetaWebhookSignature`. The returned `appId` lets the caller
 * scope what the verified event is allowed to touch — accepting either app's
 * signature must NOT let a holder of app B's secret forge events about app A's
 * pages.
 *
 * Secrets are deduped because FACEBOOK and INSTAGRAM legacy pairs normally hold
 * the SAME value; verifying the identical HMAC twice is pure cost.
 */
export function listMetaWebhookSecrets(): Array<{ appId: string; secret: string }> {
  const seen = new Set<string>();
  const out: Array<{ appId: string; secret: string }> = [];

  const push = (cred: MetaAppCredentials | null) => {
    if (!cred) return;
    // NOTE: the field is `clientSecret`, not `secret`. Reading the wrong name
    // yields `undefined`, which collapses the dedupe Set to a single entry and
    // emits candidates with no secret at all — i.e. it silently disables
    // webhook verification for every app but the first.
    if (!cred.clientSecret || seen.has(cred.clientSecret)) return;
    seen.add(cred.clientSecret);
    out.push({ appId: cred.appId, secret: cred.clientSecret });
  };

  push(legacyMetaCredentials("FACEBOOK"));
  push(legacyMetaCredentials("INSTAGRAM"));
  for (const app of listExtraMetaApps()) push(app);

  return out;
}
