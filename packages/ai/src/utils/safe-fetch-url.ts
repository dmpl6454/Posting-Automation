/**
 * Shared SSRF-safe image URL guard + fetch helper.
 *
 * The allow/deny logic is ported verbatim (in behaviour) from the original
 * guard buried in `chat-agent.chain.ts` (`__isAllowedImageUrl` +
 * `isPrivateOrLoopbackHost`). Image URLs we fetch server-side are written by
 * our own org-scoped S3/MinIO upload flow, so the only legitimate remote hosts
 * are the configured S3 public/endpoint hosts. We fail closed: anything not on
 * the allowlist (and any private/loopback/link-local/metadata host) is rejected.
 *
 * Dependency-free: only Node built-ins and Web globals (URL, fetch, AbortSignal).
 *
 * ⚠️ These are STRING checks: they reject every internal address that can be
 * written in a URL, but not a public-looking name whose DNS points inside. To
 * actually contact a server a user named, use userHostFetch in
 * @postautomation/social, which pins the connection to checked addresses.
 */
import { isIP } from "node:net";
import * as dns from "node:dns";
import { isPrivateAddress } from "./private-address";

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const IMAGE_FETCH_ALLOWED_HOSTS: Set<string> = new Set(
  [hostOf(process.env.S3_PUBLIC_URL), hostOf(process.env.S3_ENDPOINT), "s3.amazonaws.com"].filter(
    (h): h is string => !!h,
  ),
);

function isPrivateOrLoopbackHost(rawHost: string): boolean {
  // Strip IPv6 brackets ("[::1]" → "::1") and trailing dots ("localhost." → "localhost").
  const host = rawHost.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  // Any IP literal is judged by the full address rules (./private-address.ts).
  // The regexes below only knew dotted IPv4, but the URL parser rewrites a
  // mapped IPv4 into hex — "[::ffff:169.254.169.254]" arrives as
  // "[::ffff:a9fe:a9fe]" — so loopback and the cloud metadata address passed
  // as literals (measured 2026-10-01). NAT64, 6to4 and CGNAT passed too.
  if (isIP(host)) return isPrivateAddress(host);
  // IPv4 private / loopback / link-local (covers cloud metadata 169.254.169.254)
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return true;
  }
  // IPv6 unique-local (fc00::/7 → fc/fd), link-local (fe80::/10), and
  // IPv4-mapped private ranges (::ffff:10.x / ::ffff:192.168.x / ::ffff:127.x).
  if (/^f[cd][0-9a-f]*:/.test(host) || /^fe[89ab][0-9a-f]*:/.test(host)) return true;
  if (/^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
  return false;
}

/**
 * A NAME that can only mean an internal machine: a single label (Docker compose
 * service names such as minio, web, redis, postgres) or a reserved internal
 * suffix. Only for the PUBLIC-url guards — isAllowedImageUrl must keep
 * accepting the configured S3_ENDPOINT, which is `minio` in production.
 */
function isInternalHostName(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!host || isIP(host)) return false;
  if (!host.includes(".")) return true;
  return /\.(local|localhost|internal|lan|intranet|home\.arpa)$/.test(host);
}

/**
 * Returns true only if `url` is safe to fetch server-side:
 *  - a `data:image/(png|jpeg|jpg|webp|gif);base64,...` URL, OR
 *  - an http(s) URL whose host is a configured S3 host AND is not a
 *    private/loopback/link-local/metadata IP literal.
 * Everything else (other schemes, arbitrary hosts, `localhost`, private IPs)
 * is rejected. Fails closed: if the S3 allowlist is empty (misconfig), no
 * remote host is allowed.
 */
export function isAllowedImageUrl(url: string): boolean {
  // Inline base64 image data — no network fetch, safe by construction.
  // `avif` included to match the content-type set accepted on real fetches below.
  if (/^data:image\/(png|jpeg|jpg|webp|gif|avif);base64,/i.test(url)) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host)) return false;
  // Truly fail closed: only ever fetch from a configured S3 host. If the
  // allowlist is empty (misconfig), fetch nothing. Never fall back to
  // "any https host" (that would re-open SSRF).
  return IMAGE_FETCH_ALLOWED_HOSTS.has(host);
}

/**
 * Looser guard for LOGO / brand-avatar URLs. Unlike `isAllowedImageUrl`, this
 * does NOT restrict to the S3 allowlist — logos and channel avatars can
 * legitimately live on external public CDNs (NewsGrid / autopilot use channel
 * avatar URLs). It still fails closed against SSRF: only `data:image` URLs and
 * `https:` URLs whose host is NOT a private/loopback/link-local/metadata host
 * are allowed. `http:` (non-TLS) is rejected.
 *
 * Returns true iff:
 *  - a `data:image/(png|jpeg|jpg|webp|gif);base64,...` URL, OR
 *  - an `https:` URL whose host is a public (non-private/loopback/metadata) host.
 */
export function isPublicImageUrl(url: string): boolean {
  // Inline base64 image data — no network fetch, safe by construction.
  // `avif` included to match the content-type set accepted on real fetches below.
  if (/^data:image\/(png|jpeg|jpg|webp|gif|avif);base64,/i.test(url)) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // TLS only — block plaintext http: even for public hosts.
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host) || isInternalHostName(host)) return false;
  // Any public host is allowed (external CDNs included). No S3 allowlist.
  return true;
}

/** True only for a fetchable public http(s) page URL (blocks private/loopback/link-local/metadata hosts). Use before fetching a user-supplied PAGE url (e.g. og:image extraction). */
export function isPublicPageUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.replace(/\.+$/, "").toLowerCase();
  if (!host) return false;
  if (isPrivateOrLoopbackHost(host) || isInternalHostName(host)) return false;
  return true;
}

/**
 * SSRF-safe fetch for image URLs. Throws if the URL is not allowed by
 * `isAllowedImageUrl`. Uses `redirect: "manual"` so a 30x cannot bounce the
 * request to an internal target, and aborts after `timeoutMs` (default 10s).
 */
export async function safeFetchImage(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<Response> {
  if (!isAllowedImageUrl(url)) {
    throw new Error(`Refusing to fetch disallowed image URL: ${url.slice(0, 80)}`);
  }
  return fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 10000),
  });
}

/**
 * SSRF-safe fetch for PUBLIC image URLs (external CDNs included). Unlike
 * `safeFetchImage`, this gates on `isPublicImageUrl` (any public host; blocks
 * private/loopback/link-local/metadata) rather than the strict S3 allowlist, so
 * it can be used for aesthetic-reference / logo / brand-avatar URLs.
 *
 * Returns the decoded `{ base64, mimeType }` or `null` on any failure. Fails
 * closed:
 *  - rejects disallowed URLs (`isPublicImageUrl` false) without fetching;
 *  - inline `data:image/...` URLs are decoded WITHOUT a network call;
 *  - `redirect: "manual"` so a 30x cannot bounce to an internal target
 *    (a 30x surfaces as `res.ok === false` → treated as failure);
 *  - aborts after `timeoutMs` (default 10s);
 *  - requires an `image/(png|jpe?g|webp|gif)` content-type;
 *  - caps the body at `maxBytes` (default 8 MiB).
 */
export async function safeFetchPublicImage(
  url: string,
  opts?: { maxBytes?: number; timeoutMs?: number },
): Promise<{ base64: string; mimeType: string } | null> {
  if (!isPublicImageUrl(url)) return null;
  if (url.startsWith("data:image/")) {
    const [, mimeType = "image/png", b64 = ""] =
      url.match(/^data:(image\/(?:png|jpe?g|webp|gif|avif));base64,(.*)$/s) ?? [];
    return b64 ? { base64: b64, mimeType } : null;
  }
  const maxBytes = opts?.maxBytes ?? 8 * 1024 * 1024;
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  let res: Response;
  try {
    // FIX 1(a) (Round 16): send a realistic browser User-Agent + Accept header so
    // CDNs that gate image bytes on UA/Accept (many news publishers) serve us the
    // file instead of a 403. SSRF posture is unchanged — redirect:"manual" still
    // blocks 30x chaining and isPublicImageUrl already gated the host above. Used
    // widely (logos, refs, hero photos) — adding these headers is backward-compatible.
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
      },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null; // manual redirect → res.ok false for 30x; treat as failure
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const mediaType = ct.split(";")[0]?.trim() || "";
  // FIX 1(a): also accept avif (modern CDNs increasingly serve it).
  if (!/^image\/(png|jpe?g|webp|gif|avif)$/.test(mediaType)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) return null;
  const mimeType = mediaType || "image/png";
  return { base64: buf.toString("base64"), mimeType };
}

/**
 * Does EVERY address `hostname` resolves to sit on the public internet? The
 * string checks above cannot see a public-looking name whose DNS points inside
 * (10.x, a Docker service address, 127.0.0.1); this can. A later fetch()
 * resolves the name again, so an answer that flips in between is still a gap —
 * to contact a server a user named with that closed too, use userHostFetch in
 * @postautomation/social.
 */
export async function hostResolvesPublic(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return false;
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * fetch() a URL a user supplied, following redirects BY HAND: every hop must
 * pass isPublicPageUrl and hostResolvesPublic before it is requested. With
 * redirect:"follow" a public page could 302 to http://minio:9000/ or
 * http://10.x/ and the reply came back to the user (repurpose URL extraction,
 * reproduced 2026-10-01). After `maxHops` redirects the last 3xx is returned
 * unfollowed (callers treat it as not ok).
 */
export async function fetchPublicUrl(url: string, init: RequestInit = {}, maxHops = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!isPublicPageUrl(current) || !(await hostResolvesPublic(new URL(current).hostname))) {
      throw new Error("Refusing to fetch a URL that is not on the public internet.");
    }
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location || hop >= maxHops) return res;
    current = new URL(location, current).toString();
  }
}
