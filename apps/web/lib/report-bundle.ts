/**
 * "Download per campaign" (2026-10-03, owner: "campaign wise report download").
 *
 * Splits the Reports rows into ONE CSV PER CAMPAIGN — a campaign being the
 * `campaignLabel` typed in Compose when there is one, and otherwise the POST
 * itself (one fan-out is what the owner calls a campaign, and most posts carry
 * no label) — plus an index.csv that totals each group. Pure: the caller
 * supplies the SAME header + row mapper the single-file export uses, so every
 * per-campaign file is column-identical to the download it replaces.
 */
import { toCsv } from "./csv";

const CSV_BOM = "\uFEFF";

export interface BundleRowBase {
  postId: string;
  contentPreview: string;
  campaignLabel?: string | null;
  channelName: string;
  views?: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  reach: number | null;
  saved?: number | null;
}

export interface ReportGroup<R extends BundleRowBase> {
  kind: "campaign" | "post";
  /** Campaign label, or the post id. */
  key: string;
  /** Human label for index.csv. */
  title: string;
  /** Path inside the archive. */
  fileName: string;
  rows: R[];
}

export function slugify(text: string, max = 40): string {
  const full = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= max) return full;
  const cut = full.slice(0, max);
  // Cut on a word boundary when the cap lands mid-word, unless that would
  // leave nothing (a single over-long token keeps its hard cut).
  const trimmed = full[max] === "-" ? cut : cut.replace(/-[^-]*$/, "");
  return (trimmed || cut).replace(/-+$/g, "");
}

/**
 * Groups rows in first-appearance order (rows arrive newest-first, so the
 * newest campaign/post is the first file). A label groups EVERY post that
 * carries it; an unlabelled post is its own group. File names are unique by
 * construction: campaign slugs are deduplicated with a numeric suffix, and a
 * post file always carries the post id's tail.
 */
export function groupReportRows<R extends BundleRowBase>(rows: R[]): ReportGroup<R>[] {
  const groups = new Map<string, ReportGroup<R>>();
  const usedNames = new Set<string>();
  const uniqueName = (base: string) => {
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = base.replace(/\.csv$/, `-${n++}.csv`);
    usedNames.add(name);
    return name;
  };
  for (const r of rows) {
    const label = r.campaignLabel?.trim();
    const mapKey = label ? `campaign:${label}` : `post:${r.postId}`;
    let g = groups.get(mapKey);
    if (!g) {
      if (label) {
        g = { kind: "campaign", key: label, title: label, fileName: uniqueName(`campaigns/${slugify(label) || "campaign"}.csv`), rows: [] };
      } else {
        const preview = r.contentPreview.replace(/\s+/g, " ").trim();
        const slug = slugify(preview, 40);
        g = {
          kind: "post",
          key: r.postId,
          title: preview || "(no text)",
          fileName: uniqueName(`posts/post-${r.postId.slice(-8)}${slug ? `-${slug}` : ""}.csv`),
          rows: [],
        };
      }
      groups.set(mapKey, g);
    }
    g.rows.push(r);
  }
  return [...groups.values()];
}

/** Sum a metric over rows, or null when NO row reported it (never a fake 0). */
function sumMetric<R extends BundleRowBase>(rows: R[], get: (r: R) => number | null | undefined): number | null {
  let total: number | null = null;
  for (const r of rows) {
    const v = get(r);
    if (typeof v === "number" && Number.isFinite(v)) total = (total ?? 0) + v;
  }
  return total;
}

export const INDEX_HEADER = [
  "Campaign / Post",
  "Type",
  "Posts",
  "Channels published",
  "Views",
  "Impressions",
  "Likes",
  "Comments",
  "Shares",
  "Reach (summed)",
  "Saves",
  "File",
] as const;

export function buildIndexRows<R extends BundleRowBase>(groups: ReportGroup<R>[]): (string | number | null)[][] {
  return groups.map((g) => [
    g.title,
    g.kind === "campaign" ? "Campaign" : "Post",
    new Set(g.rows.map((r) => r.postId)).size,
    g.rows.length,
    sumMetric(g.rows, (r) => r.views),
    sumMetric(g.rows, (r) => r.impressions),
    sumMetric(g.rows, (r) => r.likes),
    sumMetric(g.rows, (r) => r.comments),
    sumMetric(g.rows, (r) => r.shares),
    // Per-post reach summed across posts counts a viewer once per post they
    // saw — the same "Reach (summed)" caveat the Insights aggregates carry.
    sumMetric(g.rows, (r) => r.reach),
    sumMetric(g.rows, (r) => r.saved),
    g.fileName,
  ]);
}

export interface ReportBundle {
  zipName: string;
  files: { name: string; content: string }[];
  groups: number;
}

/**
 * One CSV per group + index.csv. `header`/`toRow` are the single-file export's
 * own column builders, passed in so the two downloads cannot drift.
 */
export function buildReportBundle<R extends BundleRowBase>(opts: {
  rows: R[];
  header: string[];
  toRow: (r: R) => (string | number | null | undefined)[];
  window: string;
  mode: string;
  date: string;
  truncated?: boolean;
}): ReportBundle {
  const groups = groupReportRows(opts.rows);
  // Same UTF-8 BOM `downloadCsv` prepends: without it Excel reads a caption's
  // emoji / Devanagari as mojibake, and the per-campaign files would differ
  // from the single download by exactly that.
  const bom = (csv: string) => CSV_BOM + csv;
  const files = [
    { name: "index.csv", content: bom(toCsv([...INDEX_HEADER], buildIndexRows(groups))) },
    ...groups.map((g) => ({ name: g.fileName, content: bom(toCsv(opts.header, g.rows.map(opts.toRow))) })),
  ];
  return {
    zipName: `postautomation-reports-by-campaign-${opts.window}-${opts.mode}-${opts.date}${opts.truncated ? "-truncated" : ""}.zip`,
    files,
    groups: groups.length,
  };
}
