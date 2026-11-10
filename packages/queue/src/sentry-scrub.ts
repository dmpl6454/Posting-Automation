/**
 * Strip secrets from anything sent to Sentry (2026-11-10). Shared by the web
 * server, the browser and the worker so all three scrub the same way.
 *
 * DEPENDENCY-FREE on purpose: the browser deep-imports this file
 * (`@postautomation/queue/src/sentry-scrub`), and the queue package's index
 * opens a Redis connection.
 *
 * Why it is needed: provider error messages carry Graph URLs with
 * `access_token=…` in the query string, outgoing-request breadcrumbs record full
 * URLs, and Prisma validation errors can echo argument values such as a
 * channel's `accessToken`. Sentry's own `sendDefaultPii: false` only covers the
 * request headers/cookies it collects itself — not text inside messages.
 */

export const FILTERED = "[Filtered]";

/** Object keys whose VALUES are always secret. Matched case-insensitively. */
const SECRET_KEY_RE =
  /^(access_?token|refresh_?token|id_?token|user_?access_?token|page_?access_?token|token|client_?secret|secret|password|passwd|api_?key|apikey|authorization|cookie|set-cookie|x-api-key|session|session_?token|private_?key|webhook_?url|sealed_?secret)$/i;

/**
 * Secret-named pairs inside free text: `name=value`, `name: value`,
 * `"name":"value"`. The leading group is a boundary (start or a non-word char)
 * so `error_subcode=460` is NOT read as `code=460`; a lookbehind would do the
 * same but older Safari cannot parse one, and this file ships to the browser.
 */
const SECRET_PAIR_RE =
  /(^|[^A-Za-z0-9_])((?:access_token|refresh_token|id_token|client_secret|appsecret_proof|fb_exchange_token|password|api_key|apikey|token|x-amz-signature|x-amz-credential|x-amz-security-token)["']?\s*[=:]\s*["']?)([^&\s"',;}]+)/gi;

/**
 * Names that are secret ONLY in a query string (`code=` is an OAuth code, but
 * `"code":190` is Meta's error code and must stay readable).
 */
const SECRET_QUERY_RE = /(^|[?&])((?:code|key|sig|signature|state)=)([^&\s"']+)/gi;

/** Bearer / OAuth credentials in an Authorization-style string. */
const AUTH_SCHEME_RE = /\b(Bearer|OAuth|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

/** Long opaque tokens that look like Meta / OpenAI / Anthropic / Stripe keys. */
const KNOWN_TOKEN_RE =
  /\b(EAA[A-Za-z0-9]{20,}|IGQ[A-Za-z0-9_-]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|enc:v1:[A-Za-z0-9+/=:._-]{8,})/g;

/** Scrub one string. Keeps the parameter NAME so the event stays readable. */
export function scrubString(input: string): string {
  if (!input) return input;
  return input
    .replace(SECRET_PAIR_RE, (_m, pre: string, name: string) => `${pre}${name}${FILTERED}`)
    .replace(SECRET_QUERY_RE, (_m, pre: string, name: string) => `${pre}${name}${FILTERED}`)
    .replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} ${FILTERED}`)
    .replace(KNOWN_TOKEN_RE, FILTERED);
}

/**
 * Deep-scrub any value: secret-named keys lose their values, every string is
 * passed through `scrubString`. Cycles and very deep nesting are cut off
 * rather than followed. Returns a NEW value; the input is not mutated.
 */
export function scrubValue<T>(value: T, depth = 0, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") return scrubString(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (depth > 12) return FILTERED as unknown as T;
  if (seen.has(value as object)) return "[Circular]" as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(v, depth + 1, seen)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) && v != null && v !== "" ? FILTERED : scrubValue(v, depth + 1, seen);
  }
  return out as T;
}

/**
 * `beforeSend` / `beforeSendTransaction` / `beforeBreadcrumb` for Sentry. Also
 * drops request cookies and headers outright — the session cookie must never
 * leave the box.
 */
export function scrubSentryEvent<T>(event: T): T {
  if (!event || typeof event !== "object") return event;
  const e = scrubValue(event) as any;
  if (e.request) {
    delete e.request.cookies;
    delete e.request.headers;
    if (typeof e.request.query_string === "string") e.request.query_string = scrubString(e.request.query_string);
    // Request bodies are user content (captions, DMs) — never send them.
    delete e.request.data;
  }
  if (e.user) {
    // Keep only the opaque id; no email, IP or username.
    e.user = e.user.id ? { id: String(e.user.id) } : undefined;
  }
  return e;
}

/** Parse a sample rate env value; anything invalid falls back. */
export function sentrySampleRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}
