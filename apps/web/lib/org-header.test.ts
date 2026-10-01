import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getCurrentOrgId, orgHeaders, ORG_HEADER } from "./org-header";
import { readSourceWithoutComments } from "./source-lock";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getCurrentOrgId / orgHeaders", () => {
  it("is empty on the server (no window)", () => {
    expect(getCurrentOrgId()).toBe("");
    expect(orgHeaders()).toEqual({});
  });

  it("reads the same localStorage key the tRPC client sends", () => {
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => (k === "currentOrgId" ? "org-2" : null) } });
    expect(getCurrentOrgId()).toBe("org-2");
    expect(orgHeaders()).toEqual({ "x-organization-id": "org-2" });
    expect(ORG_HEADER).toBe("x-organization-id");
  });

  it("omits the header when no workspace is stored", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null } });
    expect(orgHeaders()).toEqual({});
  });

  it("never throws when storage access is blocked", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(getCurrentOrgId()).toBe("");
    expect(orgHeaders()).toEqual({});
  });
});

/**
 * Without the header, /api/upload files the Media row under the user's DEFAULT
 * org, while every tRPC consumer (chat.sendMessage, post.create, ...) checks
 * ownership against the ACTIVE org — so attachments uploaded in a non-default
 * workspace were rejected. Every client call must send the active org.
 */
const WEB = join(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Each `fetch(` call whose first argument is exactly "/api/upload", with its full argument text. */
function uploadFetchCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /fetch\(\s*(["'`])\/api\/upload\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = m.index + "fetch".length;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    calls.push(src.slice(open, i + 1));
  }
  return calls;
}

describe("every client fetch to /api/upload sends the active org", () => {
  const files = [...walk(join(WEB, "app")), ...walk(join(WEB, "components")), ...walk(join(WEB, "lib"))];
  const sites = files.flatMap((f) => {
    const rel = relative(join(WEB, "..", ".."), f);
    return uploadFetchCalls(readSourceWithoutComments(rel)).map((call) => ({ file: rel, call }));
  });

  it("finds the known call sites (guards against the scan silently matching nothing)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(9);
  });

  it.each(sites.map((s) => [s.file, s.call] as const))("%s passes headers: orgHeaders()", (_file, call) => {
    expect(call).toMatch(/headers:\s*orgHeaders\(\)/);
  });

  it("no file builds the /api/upload URL any other way", () => {
    for (const f of files) {
      const rel = relative(join(WEB, "..", ".."), f);
      const src = readSourceWithoutComments(rel);
      const literals = src.match(/(["'`])\/api\/upload\1/g) ?? [];
      expect({ file: rel, count: literals.length }).toEqual({ file: rel, count: uploadFetchCalls(src).length });
    }
  });
});
