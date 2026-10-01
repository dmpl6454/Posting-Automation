/**
 * userHostFetch — the only way the app may contact a server a USER named
 * (a Mastodon instance, a self-hosted WordPress site, a webhook endpoint).
 *
 * The connect-time checks (PR #206) vetted the host ONCE; every later request
 * used plain fetch(), which resolves the name again (DNS rebinding), follows
 * redirects to internal hosts, has no deadline, and echoed response bodies
 * into user-visible errors. These tests lock the replacement:
 *   - the address that is checked is the address the socket connects to;
 *   - IP literals are checked without any lookup (net.connect skips lookup for them);
 *   - redirects are never followed;
 *   - every error has fixed text (no hostname, no body) and says whether the
 *     request reached the server — the publish path needs that to tell
 *     "nothing was sent" from "the post may already exist".
 * Fully offline: a fake resolver plus a loopback server that only the
 * test-only allow-list admits.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createPinnedLookup,
  userHostFetch,
  isUserHostError,
  type ResolveAll,
  type UserHostDeps,
} from "../utils/user-host-fetch";

const PUBLIC = { address: "93.184.215.14", family: 4 };

function callLookup(lk: ReturnType<typeof createPinnedLookup>, host: string, opts: object) {
  return new Promise<{ err: any; addr: any; fam: any }>((r) =>
    lk(host, opts as any, (err: any, addr: any, fam?: any) => r({ err, addr, fam })),
  );
}

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: Buffer };
const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function server(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    const b: Buffer[] = [];
    req.on("data", (c) => b.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(b) });
      handler(req, res);
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as AddressInfo).port, seen };
}

/** Test-only: lets the loopback server through. Production callers never pass deps. */
function loopback(counter = { n: 0 }): UserHostDeps {
  return {
    resolveAll: (async () => {
      counter.n++;
      return [{ address: "127.0.0.1", family: 4 }];
    }) as ResolveAll,
    isAllowedAddress: (ip: string) => ip === "127.0.0.1",
  };
}

async function caught(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("createPinnedLookup", () => {
  it("answers in both callback shapes Node uses (all:true array, and address+family)", async () => {
    const lk = createPinnedLookup({ resolveAll: async () => [PUBLIC] });
    expect((await callLookup(lk, "x.test", { all: true, hints: 1024 })).addr).toEqual([PUBLIC]);
    const one = await callLookup(lk, "x.test", {});
    expect(one.addr).toBe(PUBLIC.address);
    expect(one.fam).toBe(4);
  });

  it.each([
    [[{ address: "10.0.0.5", family: 4 }]],
    [[{ address: "169.254.169.254", family: 4 }]],
    [[{ address: "172.18.0.4", family: 4 }]], // a Docker compose service address
    [[PUBLIC, { address: "::ffff:127.0.0.1", family: 6 }]], // one bad answer refuses the whole name
  ])("refuses an answer containing a non-public address: %j", async (answer) => {
    const r = await callLookup(createPinnedLookup({ resolveAll: async () => answer }), "x.test", { all: true });
    expect(isUserHostError(r.err)).toBe(true);
    expect(r.err.kind).toBe("blocked");
  });

  it("an empty answer is a lookup failure, not a block", async () => {
    const r = await callLookup(createPinnedLookup({ resolveAll: async () => [] }), "x.test", { all: true });
    expect(r.err.kind).toBe("transport");
    expect(r.err.code).toBe("ENOTFOUND");
    expect(r.err.requestSent).toBe(false);
  });
});

describe("userHostFetch — refusals before any connection", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://[::ffff:a9fe:a9fe]/", // the metadata address as an IPv4-mapped IPv6 literal
    "http://0x7f000001/", // WHATWG URL normalises this to 127.0.0.1
    "https://10.1.2.3/",
  ])("vets the IP literal %s without asking the resolver", async (url) => {
    let resolved = 0;
    const err = await caught(userHostFetch(url, {}, { resolveAll: async () => (resolved++, [PUBLIC]) }));
    expect(err.kind).toBe("blocked");
    expect(err.requestSent).toBe(false);
    expect(resolved).toBe(0);
  });

  it("with the real resolver, a name that resolves to loopback is refused", async () => {
    expect((await caught(userHostFetch("http://localhost:9/"))).kind).toBe("blocked");
  });

  it.each(["https://user:pass@example.com/", "https://user@example.com/", "ftp://example.com/", "file:///etc/passwd"])(
    "refuses %s (credentials in the URL, or not http(s))",
    async (url) => {
      // node:http would turn user:pass into an Authorization: Basic header; fetch refused such URLs.
      const err = await caught(userHostFetch(url, {}, { resolveAll: async () => [PUBLIC] }));
      expect(err.kind).toBe("bad_url");
      expect(err.requestSent).toBe(false);
    },
  );
});

describe("userHostFetch — requests", () => {
  it("sends JSON, DELETE, multipart and raw bodies, keeping the user's hostname as Host", async () => {
    const { port, seen } = await server((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: 7 }));
    });
    const base = `http://wp.test:${port}`;
    const d = loopback();
    const r1 = await userHostFetch(
      `${base}/wp-json/wp/v2/posts`,
      { method: "POST", headers: { Authorization: "Basic abc", "Content-Type": "application/json" }, body: JSON.stringify({ title: "t" }) },
      d,
    );
    expect(r1.ok).toBe(true);
    expect(await r1.json()).toEqual({ id: 7 });
    await userHostFetch(`${base}/wp-json/wp/v2/posts/7?force=true`, { method: "DELETE" }, d);
    const fd = new FormData();
    fd.append("file", new Blob([Buffer.from("IMG")], { type: "image/png" }), "upload.png");
    await userHostFetch(`${base}/api/v2/media`, { method: "POST", body: fd }, d);
    await userHostFetch(
      `${base}/wp-json/wp/v2/media`,
      { method: "POST", headers: { "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="a.png"' }, body: Buffer.from("RAW") },
      d,
    );

    expect(seen[0]!.headers.host).toBe(`wp.test:${port}`);
    expect(seen[0]!.headers.authorization).toBe("Basic abc");
    expect(seen[0]!.body.toString()).toBe('{"title":"t"}');
    expect(seen[0]!.headers["user-agent"]).toMatch(/PostAutomation/);
    expect(seen[0]!.headers["accept-encoding"]).toBeUndefined(); // node:http would not decompress
    expect(seen[1]!.method).toBe("DELETE");
    expect(seen[2]!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[2]!.body.toString()).toMatch(/filename="upload.png"/);
    expect(seen[3]!.headers["content-length"]).toBe("3");
    expect(seen[3]!.headers["content-disposition"]).toBe('attachment; filename="a.png"');
  });

  it("never follows a redirect, and reports its status", async () => {
    const { port, seen } = await server((_req, res) => {
      res.statusCode = 307;
      res.setHeader("location", "http://169.254.169.254/");
      res.end();
    });
    const err = await caught(userHostFetch(`http://wp.test:${port}/x`, { method: "POST", body: "{}" }, loopback()));
    expect(err.kind).toBe("redirect");
    expect(err.status).toBe(307);
    expect(err.requestSent).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("returns a null-body Response for 204 (new Response(body, {status:204}) would throw)", async () => {
    const { port } = await server((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    const r = await userHostFetch(`http://wp.test:${port}/x`, { method: "DELETE" }, loopback());
    expect(r.status).toBe(204);
  });

  it("returns non-2xx responses for the caller to judge", async () => {
    const { port } = await server((_req, res) => {
      res.statusCode = 422;
      res.end('{"error":"nope"}');
    });
    const r = await userHostFetch(`http://wp.test:${port}/x`, {}, loopback());
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "nope" });
  });

  it("discards an oversized response", async () => {
    const { port } = await server((_req, res) => {
      const t = setInterval(() => res.write("x".repeat(65536)), 1);
      res.on("close", () => clearInterval(t));
    });
    const err = await caught(userHostFetch(`http://wp.test:${port}/big`, { maxResponseBytes: 100_000 }, loopback()));
    expect(err.kind).toBe("response_too_big");
    expect(err.requestSent).toBe(true);
  });

  it("with truncateAtCap, an oversized reply resolves with its real status and the first bytes", async () => {
    const { port } = await server((_req, res) => {
      res.statusCode = 200;
      res.end("y".repeat(300_000));
    });
    const r = await userHostFetch(`http://wp.test:${port}/big`, { maxResponseBytes: 1000, truncateAtCap: true }, loopback());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("y".repeat(1000));
  });

  it("gives up at the deadline; the server had the request, so it counts as sent", async () => {
    const { port, seen } = await server(() => {
      /* never answers */
    });
    const t0 = Date.now();
    const err = await caught(userHostFetch(`http://wp.test:${port}/slow`, { method: "POST", body: "{}", timeoutMs: 300 }, loopback()));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(err.kind).toBe("transport");
    expect(err.code).toBe("ETIMEDOUT");
    expect(err.requestSent).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("a refused connection was never sent", async () => {
    const { port } = await server(() => {});
    for (const s of servers.splice(0)) s.close(); // nothing listens on that port any more
    await new Promise((r) => setTimeout(r, 20));
    const err = await caught(userHostFetch(`http://wp.test:${port}/x`, { method: "POST", body: "{}" }, loopback()));
    expect(err.kind).toBe("transport");
    expect(err.code).toBe("ECONNREFUSED");
    expect(err.requestSent).toBe(false);
  });

  it("a connection dropped after the server read the request counts as sent", async () => {
    const { port } = await server((req) => req.socket.destroy());
    const err = await caught(userHostFetch(`http://wp.test:${port}/x`, { method: "POST", body: "{}" }, loopback()));
    expect(err.kind).toBe("transport");
    expect(err.requestSent).toBe(true);
  });

  it("never reuses a pooled keep-alive socket that skipped the pinned lookup (agent: false)", async () => {
    const { port } = await server((_q, s) => s.end("{}"));
    // Other code in the same process leaves a keep-alive socket to wp.test:<port>
    // in the global agent's pool, opened WITHOUT our lookup.
    await new Promise<void>((resolve, reject) => {
      const r = http.get(
        {
          host: "wp.test",
          port,
          path: "/",
          agent: http.globalAgent,
          lookup: ((_h: string, o: any, cb: any) =>
            o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as any,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      r.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 20)); // let the socket return to the pool
    const c = { n: 0 };
    await userHostFetch(`http://wp.test:${port}/`, {}, loopback(c));
    expect(c.n).toBe(1); // our lookup ran, so this was a fresh socket
  });

  it("resolves exactly once per request: the vetted answer is the one used (no rebinding window)", async () => {
    let n = 0;
    const rebinder: ResolveAll = async () => (n++ === 0 ? [PUBLIC] : [{ address: "127.0.0.1", family: 4 }]);
    await rebinder("evil.test", {}); // a separate earlier "check" saw the public answer
    expect((await caught(userHostFetch("http://evil.test/", {}, { resolveAll: rebinder }))).kind).toBe("blocked");
    expect(n).toBe(2);

    const c = { n: 0 };
    const { port } = await server((_q, s) => s.end("{}"));
    await userHostFetch(`http://wp.test:${port}/`, {}, loopback(c));
    expect(c.n).toBe(1);
  });
});

describe("userHostFetch — error text is fixed", () => {
  // classifyError() in the publish worker substring-matches messages: a hostname
  // like token-invalid.example would read as "token expired", and fd00::401 as a
  // 401. Neither the hostname nor any response body may reach the message.
  it("a DNS failure carries the code but not the hostname", async () => {
    const dnsErr = Object.assign(new Error("getaddrinfo ENOTFOUND token-invalid.example"), { code: "ENOTFOUND" });
    const err = await caught(
      userHostFetch("https://token-invalid.example/", {}, { resolveAll: async () => Promise.reject(dnsErr) }),
    );
    expect(err.kind).toBe("transport");
    expect(err.code).toBe("ENOTFOUND");
    expect(err.message).not.toMatch(/token|invalid|example/i);
  });

  it("a block never names the host or address", async () => {
    const err = await caught(
      userHostFetch("https://permission-401.example/", {}, { resolveAll: async () => [{ address: "fd00::401", family: 6 }] }),
    );
    expect(err.kind).toBe("blocked");
    expect(err.message).not.toMatch(/permission|401|example|fd00/i);
  });
});
