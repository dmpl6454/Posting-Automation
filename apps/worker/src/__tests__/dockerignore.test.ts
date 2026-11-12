/**
 * The worker crash-looped for ~33h (2026-11-10 → 11-12) because image builds
 * copied the server checkout's stale node_modules over the installed ones.
 * .dockerignore must keep excluding every node_modules folder.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const root = path.join(__dirname, "..", "..", "..", "..");

describe(".dockerignore", () => {
  it("excludes node_modules at every depth", () => {
    const lines = readFileSync(path.join(root, ".dockerignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(lines).toContain("**/node_modules");
  });
});
