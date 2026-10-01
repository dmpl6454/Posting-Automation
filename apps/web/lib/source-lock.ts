import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Comment stripper for source-lock tests. A comment only starts at line start
 * or after whitespace / `{` (JSX `{/* … *\/}`), so `accept="image/*"` and
 * `"https://…"` are left alone — a naive `/\/\*[\s\S]*?\*\//g` treats the first
 * as a comment opener and silently swallows the code after it.
 */
export function stripSourceComments(src: string): string {
  return src
    .replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, "$1")
    .replace(/(^|[\s{;])\/\/.*$/gm, "$1");
}

const REPO_ROOT = join(__dirname, "..", "..", "..");

/** Read a repo file (path relative to the repo root) with comments stripped. */
export function readSourceWithoutComments(relPath: string): string {
  return stripSourceComments(readFileSync(join(REPO_ROOT, relPath), "utf8"));
}
