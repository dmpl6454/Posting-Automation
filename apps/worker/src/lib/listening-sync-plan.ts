import { createHash } from "node:crypto";

/**
 * Pure planning helpers for the listening-sync worker (2026-10-04). No I/O,
 * no Prisma — everything here is unit-tested in listening-sync-plan.test.ts
 * and the worker only wires the results to the platform APIs and the DB.
 *
 * Why this exists: the worker used to issue ONE request per keyword per
 * platform, a `findFirst` per fetched mention, and never deduplicated a
 * mention that had no URL (LinkedIn) — so a 3-keyword query re-inserted the
 * same LinkedIn posts every 30 minutes and spent dozens of DB round trips per
 * run. The helpers below give every mention a stable identity, collapse the
 * keywords into as few platform requests as the APIs allow, and decide once
 * per run what is genuinely new.
 */

export interface RawMentionIdentity {
  source: string;
  /** The platform's own id for the post (tweet id, video id, post URN…). Preferred key. */
  platformPostId?: string | null;
  sourceUrl: string | null;
  content: string;
}

/** Longest key stored verbatim; anything longer is hashed so the index stays small. */
export const DEDUP_KEY_MAX = 200;

/** Lower-cased, whitespace-collapsed text — the basis of content-hash identity. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Normalise a permalink for identity: drop the fragment and tracking params,
 * lower-case the host. Two shares of one article with different utm_ tags are
 * the same mention.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|igshid$|ref$|ref_src$)/i.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return url.trim();
  }
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/**
 * Stable identity of a mention WITHIN its listening query, in precedence
 * order: the platform's own post id → the normalised permalink → a hash of
 * the normalised content. The result is what `Mention.dedupKey` stores and
 * what the (listeningQueryId, dedupKey) unique index enforces.
 */
export function mentionDedupKey(raw: RawMentionIdentity): string {
  const source = raw.source.toUpperCase();
  let key: string;
  if (raw.platformPostId && String(raw.platformPostId).trim()) {
    key = `${source}:id:${String(raw.platformPostId).trim()}`;
  } else if (raw.sourceUrl && raw.sourceUrl.trim()) {
    key = `${source}:url:${normalizeUrl(raw.sourceUrl)}`;
  } else {
    key = `${source}:text:${sha1(normalizeText(raw.content))}`;
  }
  return key.length > DEDUP_KEY_MAX ? `${source}:h:${sha1(key)}` : key;
}

/** The permalink LinkedIn renders for a post URN, or null for an unexpected shape. */
export function linkedInPostUrl(urn: string | null | undefined): string | null {
  if (!urn) return null;
  const m = /^urn:li:(share|ugcPost|activity):(\d+)$/.exec(urn.trim());
  if (!m) return null;
  return `https://www.linkedin.com/feed/update/${m[0]}/`;
}

/** Trim, drop empties, dedupe case-insensitively, keep first spelling. */
export function cleanKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const k = raw.trim().replace(/\s+/g, " ");
    if (!k) continue;
    const lower = k.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(k);
  }
  return out;
}

export interface KeywordChunkOptions {
  /** Keywords per combined request. */
  maxPerChunk?: number;
  /** Upper bound on the rendered OR-query length (Twitter basic: 512; Reddit ~512). */
  maxChars?: number;
}

/**
 * Group keywords so each group fits one OR-combined search request. A single
 * keyword longer than the budget still gets its own chunk (it is sent as-is;
 * the platform decides). Order is preserved.
 */
export function chunkKeywords(keywords: string[], opts: KeywordChunkOptions = {}): string[][] {
  const maxPerChunk = opts.maxPerChunk ?? 5;
  const maxChars = opts.maxChars ?? 400;
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const k of cleanKeywords(keywords)) {
    const next = [...current, k];
    if (current.length > 0 && (next.length > maxPerChunk || orQuery(next).length > maxChars)) {
      chunks.push(current);
      current = [k];
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** One search term: a phrase (spaces or operator characters) is quoted. */
export function searchTerm(keyword: string): string {
  const k = keyword.replace(/"/g, "").trim();
  return /[\s:()\-]/.test(k) ? `"${k}"` : k;
}

/** `a OR "b c" OR d` — the syntax Twitter, Reddit and Google News all accept. */
export function orQuery(keywords: string[]): string {
  const terms = keywords.map(searchTerm).filter(Boolean);
  if (terms.length <= 1) return terms[0] ?? "";
  return terms.join(" OR ");
}

export function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => k.trim() && lower.includes(k.trim().toLowerCase()));
}

export function hasExcludedWord(text: string, excludeWords: string[]): boolean {
  if (excludeWords.length === 0) return false;
  const lower = text.toLowerCase();
  return excludeWords.some((w) => w.trim() && lower.includes(w.trim().toLowerCase()));
}

export interface MentionBatchPlan<T> {
  /** Mentions to insert, each with its dedupKey, in input order. */
  rows: Array<T & { dedupKey: string }>;
  skipped: { excluded: number; duplicateInBatch: number; alreadyStored: number };
}

/**
 * Decide, in memory and in one pass, which fetched mentions are new: drop the
 * ones carrying an excluded word, collapse duplicates inside the batch (the
 * same tweet matching two keywords), and drop anything the DB already holds —
 * by dedupKey for rows written since the column existed, by sourceUrl for the
 * legacy rows before it. The caller supplies the two "existing" sets from ONE
 * query over the candidate keys/urls.
 */
export function planMentionBatch<T extends RawMentionIdentity>(
  raws: T[],
  opts: { excludeWords: string[]; existingKeys: Set<string>; existingUrls: Set<string> }
): MentionBatchPlan<T> {
  const rows: Array<T & { dedupKey: string }> = [];
  const seen = new Set<string>();
  const skipped = { excluded: 0, duplicateInBatch: 0, alreadyStored: 0 };
  for (const raw of raws) {
    if (hasExcludedWord(raw.content, opts.excludeWords)) {
      skipped.excluded++;
      continue;
    }
    const dedupKey = mentionDedupKey(raw);
    if (seen.has(dedupKey)) {
      skipped.duplicateInBatch++;
      continue;
    }
    seen.add(dedupKey);
    const url = raw.sourceUrl?.trim();
    if (opts.existingKeys.has(dedupKey) || (url && opts.existingUrls.has(url))) {
      skipped.alreadyStored++;
      continue;
    }
    rows.push({ ...raw, dedupKey });
  }
  return { rows, skipped };
}

/** Candidate identities to look up in ONE query before planning the batch. */
export function candidateIdentities(raws: RawMentionIdentity[]): { keys: string[]; urls: string[] } {
  const keys = new Set<string>();
  const urls = new Set<string>();
  for (const raw of raws) {
    keys.add(mentionDedupKey(raw));
    const url = raw.sourceUrl?.trim();
    if (url) urls.add(url);
  }
  return { keys: [...keys], urls: [...urls] };
}

/** A surge/negative alert of the same type is not repeated inside this window. */
export const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * True when an alert of this type fired recently enough that another one
 * would be noise. The sync runs every 30 minutes; without this a sustained
 * surge produced 48 identical "volume surge" alerts a day.
 */
export function alertOnCooldown(
  lastTriggeredAt: Date | null | undefined,
  now: Date = new Date(),
  cooldownMs: number = ALERT_COOLDOWN_MS
): boolean {
  if (!lastTriggeredAt) return false;
  return now.getTime() - lastTriggeredAt.getTime() < cooldownMs;
}

/**
 * One row per Facebook Page: the same Page is connected in many workspaces /
 * several times in one org, and `/tagged` is a property of the PAGE, so a
 * second channel row for it would spend a Graph call on an identical answer.
 * The first occurrence wins — callers pass freshest-token-first.
 */
export function uniqueByPlatformId<T extends { platformId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.platformId)) return false;
    seen.add(item.platformId);
    return true;
  });
}

/**
 * The slice of `items` a run handles when only `perRun` of them may be read
 * per run: window `bucket` of the rotation, wrapping around, so every item is
 * reached within ceil(n / perRun) consecutive runs without storing a cursor.
 * `perRun <= 0` reads nothing; `perRun >= n` reads everything.
 */
export function rotateWindow<T>(items: T[], perRun: number, bucket: number): T[] {
  if (perRun <= 0 || items.length === 0) return [];
  if (perRun >= items.length) return items;
  const windows = Math.ceil(items.length / perRun);
  const start = (((Math.floor(bucket) % windows) + windows) % windows) * perRun;
  return items.slice(start, start + perRun);
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
