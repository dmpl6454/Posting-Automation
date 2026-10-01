/**
 * userHostFetch — the ONLY way the app may contact a server a USER named:
 * a Mastodon instance, a self-hosted WordPress site, a webhook endpoint.
 *
 * Why not fetch(): the connect-time validator checked the host once, but every
 * later fetch() resolved the name AGAIN (an attacker can repoint their domain
 * at 10.x, 169.254.169.254 or a Docker service address after connecting),
 * followed redirects to internal hosts, had no deadline, and the providers
 * echoed the response body into errors users can read. Node 20's global fetch
 * cannot be given a DNS lookup without the npm `undici` package, which this
 * repo does not install.
 *
 * How this closes it:
 *  - node:http / node:https with OUR `lookup`: the name is resolved once, the
 *    request is refused if ANY answer is non-public, and the socket connects
 *    only to the addresses that were checked. There is no second resolution,
 *    so DNS rebinding has no window. TLS SNI and certificate checks stay on the
 *    hostname, because the URL is never rewritten to an IP.
 *  - IP literals are checked up front: net.connect never calls `lookup` for them.
 *  - `agent: false` — a pooled keep-alive socket opened by other code without
 *    this lookup can never be reused.
 *  - Redirects are never followed; every 3xx is an error.
 *  - A total deadline and a response size cap.
 *  - Every error is a UserHostError with FIXED text: no hostname, no address,
 *    no response body. The publish worker's classifyError() substring-matches
 *    messages, so a hostname like token-invalid.example would otherwise read as
 *    "token expired", and fd00::401 as a 401.
 *  - Every error says whether the request reached the server (`requestSent`).
 *    Publishing needs that to tell "nothing was sent, safe to retry" from "the
 *    post may already exist" (see ambiguous-publish.ts).
 *
 * Returns a standard Response, so callers keep .ok / .status / .json().
 */
import * as http from "node:http";
import * as https from "node:https";
import * as dns from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateAddress } from "./public-address";

export type ResolveAll = (host: string, opts: dns.LookupOptions) => Promise<dns.LookupAddress[]>;

export interface UserHostDeps {
  /** Tests only. Default: dns.promises.lookup(host, { ...opts, all: true }). */
  resolveAll?: ResolveAll;
  /** Tests only, to admit a loopback test server. Default: not isPrivateAddress. */
  isAllowedAddress?: (ip: string) => boolean;
}

export type UserHostErrorKind =
  /** The name or IP is not a public internet address. Nothing was sent. */
  | "blocked"
  /** Not a plain http(s) URL, or it carries credentials. Nothing was sent. */
  | "bad_url"
  /** The server answered 3xx. Not followed. */
  | "redirect"
  /** The response exceeded maxResponseBytes. */
  | "response_too_big"
  /** DNS, connect, TLS, reset, deadline. See `code` and `requestSent`. */
  | "transport"
  /** A status outside 200-599, or a response that cannot be represented. */
  | "bad_status";

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "ENODATA", "ESERVFAIL"]);

function messageFor(kind: UserHostErrorKind, code: string, status?: number): string {
  switch (kind) {
    case "blocked":
      return "Refused to contact the server: its address is not a public internet address.";
    case "bad_url":
      return "Refused to contact the server: the address is not a plain http(s) web address.";
    case "redirect":
      return `The server answered with a redirect (HTTP ${status}). Redirects are not followed.`;
    case "response_too_big":
      return "The server's response was bigger than allowed and was discarded.";
    case "bad_status":
      return "The server sent an unusable response.";
    case "transport":
      if (DNS_CODES.has(code)) return "Could not look up the server's address.";
      if (code === "ECONNREFUSED") return "The server refused the connection.";
      if (code === "ETIMEDOUT") return "The server did not answer in time.";
      return "The connection to the server failed.";
  }
}

export class UserHostError extends Error {
  readonly isUserHostError = true as const;
  readonly kind: UserHostErrorKind;
  readonly code: string;
  /** True once the request was handed to the server (or it answered). */
  readonly requestSent: boolean;
  readonly status?: number;
  constructor(
    kind: UserHostErrorKind,
    opts: { code?: string; requestSent?: boolean; status?: number; cause?: unknown } = {},
  ) {
    const code = opts.code ?? (kind === "transport" ? "ECONNRESET" : `EUSERHOST_${kind.toUpperCase()}`);
    super(messageFor(kind, code, opts.status), opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "UserHostError";
    this.kind = kind;
    this.code = code;
    this.requestSent = opts.requestSent ?? false;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/** Duck-typed: under pnpm's isolated layout two copies of this module can coexist. */
export function isUserHostError(err: unknown): err is UserHostError {
  return !!err && typeof err === "object" && (err as { isUserHostError?: unknown }).isUserHostError === true;
}

const systemResolveAll: ResolveAll = (host, opts) => dns.promises.lookup(host, { ...opts, all: true });

/**
 * A net LookupFunction that pins the connection to vetted addresses. Node
 * calls it in two shapes, and both must work:
 *  - options.all true (the default since Node 20, with autoSelectFamily on):
 *    reply with an array. Node 20's lookupAndConnectMultiple iterates it with
 *    no fallback, so ignoring `all` breaks connections there.
 *  - options.all falsy (autoSelectFamily off, or an explicit family): reply
 *    with (address, family).
 * Does NOT set `verbatim`: the worker runs with --dns-result-order=ipv4first,
 * and the address order must stay exactly as it is for every other client.
 */
export function createPinnedLookup(deps: UserHostDeps = {}): LookupFunction {
  const resolveAll = deps.resolveAll ?? systemResolveAll;
  const isAllowed = deps.isAllowedAddress ?? ((ip: string) => !isPrivateAddress(ip));
  return (hostname, options, callback) => {
    const { all, ...rest } = (options ?? {}) as dns.LookupOptions;
    resolveAll(hostname, rest).then(
      (addrs) => {
        if (!addrs?.length) return callback(new UserHostError("transport", { code: "ENOTFOUND" }), "", 0);
        // An attacker controls the zone, so refuse the name outright rather than
        // filtering out the bad answers.
        if (addrs.some((a) => !isAllowed(a.address))) return callback(new UserHostError("blocked"), "", 0);
        if (all) return callback(null, addrs.map(({ address, family }) => ({ address, family })));
        return callback(null, addrs[0]!.address, addrs[0]!.family);
      },
      (err: NodeJS.ErrnoException) =>
        callback(new UserHostError("transport", { code: err?.code || "ENOTFOUND", cause: err }), "", 0),
    );
  };
}

export interface UserHostInit {
  method?: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  body?: string | Uint8Array | FormData | URLSearchParams | Blob;
  /** Total deadline: DNS, connect, upload and reading the body. Default 20s. */
  timeoutMs?: number;
  /** Default 2 MiB. */
  maxResponseBytes?: number;
  /**
   * Past maxResponseBytes, resolve with the first maxResponseBytes bytes and the
   * real status instead of failing. For callers that only need the status (a
   * webhook receiver that accepted an event and answered with a big page).
   */
  truncateAtCap?: boolean;
  signal?: AbortSignal;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const DEFAULT_USER_AGENT = "PostAutomation/1.0 (+https://postautomation.co.in)";

/** FormData / URLSearchParams / Blob → bytes + content-type, with no dependencies. */
async function encodeBody(body: UserHostInit["body"]): Promise<{ bytes?: Buffer; contentType?: string }> {
  if (body == null) return {};
  if (typeof body === "string") return { bytes: Buffer.from(body) };
  if (body instanceof Uint8Array) return { bytes: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
  const req = new Request("http://encode.invalid/", { method: "POST", body });
  return { bytes: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get("content-type") ?? undefined };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

export async function userHostFetch(rawUrl: string, init: UserHostInit = {}, deps: UserHostDeps = {}): Promise<Response> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UserHostError("bad_url");
  }
  // node:http turns user:pass@ into an Authorization: Basic header; fetch refused such URLs.
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new UserHostError("bad_url");
  }
  const isAllowed = deps.isAllowedAddress ?? ((ip: string) => !isPrivateAddress(ip));
  // net.connect never calls `lookup` for an IP literal, so it is vetted here.
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) && !isAllowed(bare)) throw new UserHostError("blocked");

  const { bytes, contentType } = await encodeBody(init.body);
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (contentType && !hasHeader(headers, "content-type")) headers["content-type"] = contentType;
  if (bytes) headers["content-length"] = String(bytes.byteLength);
  if (!hasHeader(headers, "user-agent")) headers["user-agent"] = DEFAULT_USER_AGENT;
  if (!hasHeader(headers, "accept")) headers["accept"] = "*/*";
  // No accept-encoding: node:http does not decompress, and identity keeps the size cap honest.

  const deadline = AbortSignal.timeout(init.timeoutMs ?? 20_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const cap = init.maxResponseBytes ?? 2 * 1024 * 1024;
  const mod = url.protocol === "https:" ? https : http;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let requestSent = false;
    const done = (err: Error | null, res?: Response) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(res!);
    };
    const transport = (cause: unknown) => {
      if (isUserHostError(cause)) return cause; // raised by our lookup: already fixed text
      const code = deadline.aborted
        ? "ETIMEDOUT"
        : signal.aborted
          ? "EABORTED"
          : ((cause as NodeJS.ErrnoException | null)?.code ?? "ECONNRESET");
      return new UserHostError("transport", { code, requestSent, cause });
    };

    const req = mod.request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: createPinnedLookup(deps),
        agent: false,
        signal,
      },
      (res) => {
        requestSent = true;
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          req.destroy();
          return done(new UserHostError("redirect", { status, requestSent: true }));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let ended = false;
        res.on("data", (c: Buffer) => {
          if (ended) return;
          size += c.length;
          if (size > cap) {
            if (init.truncateAtCap) {
              chunks.push(c.subarray(0, c.length - (size - cap)));
              finish();
            } else {
              done(new UserHostError("response_too_big", { requestSent: true }));
            }
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("error", (e) => done(transport(e)));
        res.on("close", () => {
          if (!ended) done(transport(new Error("closed before the end of the response")));
        });
        res.on("end", () => finish());
        function finish() {
          if (ended) return;
          ended = true;
          if (status < 200 || status > 599) return done(new UserHostError("bad_status", { status, requestSent: true }));
          const h = new Headers();
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
            try {
              h.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
            } catch {
              /* drop a header the Headers class rejects */
            }
          }
          try {
            // new Response(body, { status: 204 | 205 | 304 }) throws: those carry no body.
            const body = NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks);
            done(null, new Response(body, { status, statusText: "", headers: h }));
          } catch (e) {
            done(new UserHostError("bad_status", { status, requestSent: true, cause: e }));
          }
        }
      },
    );
    req.on("finish", () => {
      requestSent = true;
    });
    req.on("error", (e) => done(transport(e)));
    req.end(bytes);
  });
}
