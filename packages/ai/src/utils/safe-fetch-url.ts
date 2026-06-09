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
 * Dependency-free: only Node/Web globals (URL, fetch, AbortSignal).
 */

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
  // Strip IPv6 brackets: "[::1]" → "::1"
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1") return true;
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
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(url)) return true;

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
