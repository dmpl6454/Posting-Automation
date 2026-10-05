/**
 * Auto-hide rules for comments (2026-10-05) — the pure matcher.
 *
 * Used by the API (to clean what a person typed into the rule) and by the
 * worker's comment sweep (to decide whether to hide a comment). Pure, so the
 * exact matching behaviour is unit-tested.
 *
 * Matching:
 *   - case-insensitive, after Unicode NFKC normalisation (full-width letters,
 *     ligatures and compatibility forms fold to their plain form);
 *   - a term made only of letters/marks/digits matches as a WHOLE WORD ("ass" does
 *     not match "class"), using Unicode letter classes so Hindi, accented and
 *     other scripts work;
 *   - any other term (a phrase with spaces, an emoji, "$$$") matches as a
 *     plain substring, with runs of whitespace treated as one space;
 *   - `hideLinks` matches http(s):// and www. links and bare domains on common
 *     TLDs (bit.ly/x, example.com).
 */

export const MAX_BLOCKED_WORDS = 200;
export const MAX_BLOCKED_WORD_LENGTH = 60;

export interface CommentRules {
  blockedWords: readonly string[];
  hideLinks: boolean;
}

export interface RuleMatch {
  /** "word:<term>" or "link" — stored with the action so the log can say why. */
  reason: string;
}

function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Trim, fold, drop empties and duplicates, cap length and count. */
export function normalizeBlockedWords(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const term = fold(raw).slice(0, MAX_BLOCKED_WORD_LENGTH).trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_BLOCKED_WORDS) break;
  }
  return out;
}

// Letters, digits AND combining marks: Devanagari vowel signs (ा, ि …) and
// other scripts' diacritics are \p{M}, and without it "बकवास" would neither
// count as a word nor stop at a word boundary.
const WORD_ONLY = /^[\p{L}\p{M}\p{N}]+$/u;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LINK_RE =
  /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|in|co|io|me|ly|link|xyz|app|info|biz|shop|site|online|store|live|club|top|tk|gg|to|us|uk|ru|cn)\b(?:\/\S*)?/iu;

export function containsLink(text: string): boolean {
  return LINK_RE.test(text.normalize("NFKC"));
}

/**
 * The first rule a comment's text breaks, or null. Blocked words are checked
 * in the order given, then links.
 */
export function matchCommentRule(text: string, rules: CommentRules): RuleMatch | null {
  const body = fold(text ?? "");
  if (body) {
    for (const raw of rules.blockedWords) {
      const term = fold(raw);
      if (!term) continue;
      if (WORD_ONLY.test(term)) {
        const re = new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}])${escapeRegExp(term)}($|[^\\p{L}\\p{M}\\p{N}])`, "u");
        if (re.test(body)) return { reason: `word:${term}` };
      } else if (body.includes(term)) {
        return { reason: `word:${term}` };
      }
    }
  }
  if (rules.hideLinks && text && containsLink(text)) return { reason: "link" };
  return null;
}
