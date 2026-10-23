import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source lock for the scanner hardening in docker/nginx/nginx.conf (2026-10-23).
 *
 * This stack has no PHP, so *.php / wp-login.php / .env probes are always a
 * vulnerability scanner and are dropped with 444 before any proxying. The
 * rules are easy to lose in a later nginx edit, and a lost rule has no
 * failing symptom (the app just starts rendering 404s for the bots again) —
 * so the shape is asserted here. The live behaviour was verified by running
 * the config under nginx 1.24 on spare ports (see the PR for the matrix).
 */
const conf = readFileSync(join(__dirname, "../../../docker/nginx/nginx.conf"), "utf8");

describe("nginx scanner hardening", () => {
  it("defines the scanner-path map over the DECODED path", () => {
    expect(conf).toMatch(/map \$uri \$is_scanner_path \{/);
    expect(conf).toContain("\\.(php[0-9]?|phtml|phar|asp|aspx|jsp|jspx|cgi|pl)$ 1;");
    expect(conf).toMatch(/wp-login\|wp-content/);
    expect(conf).toMatch(/\^\/\\\.\(env\|git\|/);
  });

  it("drops a scanner probe in every named server: port 80, .co.in and .in", () => {
    const drops = conf.match(/if \(\$is_scanner_path\) \{ return 444; \}/g) ?? [];
    expect(drops).toHaveLength(3);
  });

  it("refuses the TLS handshake for a host that is not ours", () => {
    expect(conf).toMatch(/listen 443 ssl http2 default_server;\s*server_name _;\s*ssl_reject_handshake on;/);
  });

  it("keeps the docker healthcheck reachable on the port-80 catch-all (it is probed with Host: 127.0.0.1)", () => {
    const catchAll = conf.match(/listen 80 default_server;[\s\S]*?\n    \}/)?.[0] ?? "";
    expect(catchAll).toContain("location = /nginx-health");
    expect(catchAll).toContain("location / { return 444; }");
  });

  it("never matches the ACME challenge path (certificate renewal must keep working)", () => {
    // The dot-file rule is anchored to the names it lists; .well-known is not one of them.
    const dotRule = conf.match(/~\*\^\/\\\.\(([a-z_|]+)\)/)?.[1] ?? "";
    expect(dotRule).not.toContain("well");
    expect(conf).toContain("location /.well-known/acme-challenge/");
  });
});
