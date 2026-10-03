import type { SuperTextSegment } from "./schema";

/**
 * Typed text ⇄ segments, with MANUAL line breaks (2026-10-03).
 *
 * The editor holds the strip as one multi-line string (Enter = new line). A
 * newline becomes `break: true` on the LAST word of that line; a space stays a
 * word boundary. Empty lines and runs of whitespace collapse — the strip has no
 * notion of a blank line, and the schema rejects an empty segment.
 *
 * Both directions are pure so the round trip (text → segments → text) is
 * test-locked: re-opening the editor on a stored strip must show the user the
 * breaks they typed, in the same places.
 */

/** Tokens the editor renders as chips. `break` = a line break follows this word. */
export interface SuperTextToken {
  text: string;
  break?: true;
}

export function textToTokens(text: string): SuperTextToken[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/).filter(Boolean))
    .filter((line) => line.length > 0);
  const out: SuperTextToken[] = [];
  lines.forEach((line, li) => {
    line.forEach((word, wi) => {
      const isLastOfLine = wi === line.length - 1;
      const moreLinesFollow = li < lines.length - 1;
      out.push(isLastOfLine && moreLinesFollow ? { text: word, break: true } : { text: word });
    });
  });
  return out;
}

/** The inverse: words joined by a space, or by a newline after a break. */
export function segmentsToText(segments: ReadonlyArray<Pick<SuperTextSegment, "text" | "break">>): string {
  return segments.reduce((acc, seg, i) => {
    if (i === 0) return seg.text;
    const prev = segments[i - 1]!;
    return acc + (prev.break === true ? "\n" : " ") + seg.text;
  }, "");
}

/** Characters that count toward the strip cap: the words only, never the separators. */
export function countStripChars(text: string): number {
  return textToTokens(text).reduce((n, t) => n + t.text.length, 0);
}
