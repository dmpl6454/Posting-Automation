/**
 * Publish-notification email builder (redesign 2026-07-17; links-only body 2026-09-15).
 *
 * PURE — no prisma/nodemailer — so the template is unit-testable
 * (publish-email.test.ts, run via root vitest). The worker's
 * sendPublishReportEmail resolves the recipient (the post CREATOR — owner
 * decision 2026-07-17; previously every org OWNER/ADMIN was emailed) and
 * hands the data here.
 *
 * BODY (owner ask 2026-09-15): the live post links only, one per line — no
 * platform, channel or timestamp — so they can be copied by hand or read by a
 * script. That per-channel detail still ships, unchanged, in the attached CSV
 * (buildPublishReportCsv below).
 *
 * SECURITY: every dynamic value goes through escapeHtml, and a URL must be
 * http(s) to be listed or linked at all (no javascript: hrefs).
 */

export interface PublishEmailTarget {
  platform: string;
  channelName: string;
  channelUsername: string | null;
  status: string; // "PUBLISHED" | "FAILED" | ...
  publishedUrl: string | null;
  publishedAt: Date | string | null;
  /**
   * The publish outcome is UNKNOWN (PostTarget.ambiguousAt is set): stored as
   * FAILED, but the post may already be live. Absent = a definite outcome.
   */
  ambiguous?: boolean;
}

export interface PublishEmailInput {
  postId: string;
  postContent: string;
  appUrl: string;
  targets: PublishEmailTarget[];
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) URLs may become hrefs — anything else renders as text. */
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/** "2026-07-17 09:30 UTC (15:00 IST)" — timestamps in both zones per owner ask. */
export function fmtWhen(d: Date | string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  const utc = date.toISOString().slice(0, 16).replace("T", " ");
  const ist = date.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${utc} UTC (${ist} IST)`;
}

export function buildPublishEmail(input: PublishEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const { postId, postContent, appUrl, targets } = input;

  const published = targets.filter((t) => t.status === "PUBLISHED");
  const failed = targets.filter((t) => t.status === "FAILED");
  // A channel the user CANCELLED is neither a success nor a failure, so it is
  // out of the denominator entirely. Counting it would report "2/3 channels" for
  // a post where the third was deliberately withdrawn — reading as a partial
  // failure when nothing failed. The CSV still lists every target.
  const cancelled = targets.filter((t) => t.status === "CANCELLED");
  const attempted = targets.length - cancelled.length;

  const titleRaw = postContent.split("\n")[0]?.slice(0, 60) || "Untitled post";
  const titleSuffix = (postContent.split("\n")[0]?.length ?? 0) > 60 ? "…" : "";
  const subject =
    attempted === 0
      ? `🚫 Cancelled: "${titleRaw}${titleSuffix}" — ${cancelled.length} channel${cancelled.length === 1 ? "" : "s"} stopped before publishing`
      : published.length === attempted
        ? `✅ Published: "${titleRaw}${titleSuffix}" — ${published.length}/${attempted} channel${attempted === 1 ? "" : "s"}`
        : published.length > 0
          ? `⚠️ Partially published: "${titleRaw}${titleSuffix}" — ${published.length}/${attempted} channels`
          : `❌ Publish failed: "${titleRaw}${titleSuffix}" — 0/${attempted} channel${attempted === 1 ? "" : "s"}`;

  const dashboardUrl = `${appUrl}/dashboard/posts/${postId}`;

  // A target parked with an UNKNOWN outcome is stored as FAILED but may already
  // be live. Calling it "failed" is what invites a Retry — the 2026-08-18
  // duplicate-post incident — so it is counted on its own.
  const unconfirmed = failed.filter((t) => t.ambiguous === true).length;
  const definitelyFailed = failed.length - unconfirmed;

  const heading =
    attempted === 0
      ? "You cancelled this post before it published"
      : published.length === attempted
        ? "Your post is live"
        : published.length > 0
          ? "Your post partially published"
          : unconfirmed > 0
            ? "Your post may not have published — check before retrying"
            : "Your post could not be published";

  // Only real post URLs go in the list. The dashboard link is kept OUT of it,
  // so anything reading "the block of URLs" gets post links and nothing else.
  // ⚠️ safeHref only checks the prefix, and some providers return a URL verbatim
  // from a server the channel owner runs (self-hosted WordPress, a Mastodon
  // instance). A URL containing whitespace, a control character or a line
  // separator could split one link into several lines of the text part, so it is
  // not listed and counts toward the "no public link" note instead. A valid URL
  // never contains these raw — they are percent-encoded. Checked HERE, not in
  // safeHref, because the CSV must not change.
  const hasUnsafeChar = (u: string) =>
    [...u].some((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c <= 0x20 || c === 0x7f || c === 0x85 || c === 0xa0 || c === 0x2028 || c === 0x2029 || /\s/.test(ch);
    });
  const links = published
    .map((t) => safeHref(t.publishedUrl))
    .filter((u): u is string => u !== null && !hasUnsafeChar(u));
  const unlinked = published.length - links.length;

  // A failed channel has no link, so without these lines a partial failure
  // would just look like a shorter list.
  const notes: string[] = [];
  if (definitelyFailed > 0) {
    notes.push(`${definitelyFailed} channel${definitelyFailed === 1 ? "" : "s"} failed to publish.`);
  }
  if (unconfirmed > 0) {
    notes.push(
      `${unconfirmed} channel${unconfirmed === 1 ? "" : "s"} could not be confirmed and may already be live — check before retrying.`
    );
  }
  if (unlinked > 0) {
    notes.push(`${unlinked} published post${unlinked === 1 ? " has" : "s have"} no public link.`);
  }
  // Stated plainly so a shorter link list is explained rather than looking like
  // channels silently went missing.
  if (cancelled.length > 0 && attempted > 0) {
    notes.push(
      `${cancelled.length} channel${cancelled.length === 1 ? " was" : "s were"} cancelled before publishing.`
    );
  }

  const linkHtml = links
    .map(
      (u) =>
        `<div style="margin:0 0 6px;"><a href="${escapeHtml(u)}" style="color:#2563eb;text-decoration:none;word-break:break-all;">${escapeHtml(u)}</a></div>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:24px 16px;background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
  <div style="max-width:600px;margin:0 auto;">
    <p style="margin:0 0 16px;font-size:16px;font-weight:600;">${heading}</p>
    ${links.length > 0 ? `<div style="font-size:14px;line-height:1.5;">${linkHtml}</div>` : ""}
    ${notes.map((n) => `<p style="margin:16px 0 0;font-size:13px;color:#52525b;">${escapeHtml(n)}</p>`).join("")}
    <p style="margin:24px 0 0;font-size:13px;color:#71717a;">Dashboard: <a href="${escapeHtml(dashboardUrl)}" style="color:#71717a;">${escapeHtml(dashboardUrl)}</a></p>
  </div>
</body></html>`;

  const text = [
    heading,
    "",
    ...(links.length > 0 ? [...links, ""] : []),
    ...(notes.length > 0 ? [...notes, ""] : []),
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");

  return { subject, html, text };
}

/**
 * SECURITY — CSV/formula injection: channel names, platform strings and post
 * content are user/provider-controlled; a cell starting with = + - @ (or
 * tab/CR) executes as a formula when opened in Excel/Sheets (e.g. =HYPERLINK
 * exfiltration). Neutralize with a leading apostrophe — the standard
 * mitigation, identical to apps/web/lib/csv.ts (not importable from the
 * worker workspace, so the guard is replicated here and locked by tests).
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvField(v: string | number | null | undefined): string {
  let s = String(v ?? "");
  if (typeof v === "string" && FORMULA_PREFIX.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** ISO UTC "2026-07-17 09:30" or "" for missing/invalid dates. */
function csvUtc(d: Date | string | null): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/** IST "15:00" or "" for missing/invalid dates. */
function csvIst(d: Date | string | null): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Spreadsheet-ready per-channel report, attached to the publish email as a
 * .csv. Since 2026-09-15 the email body carries only the links, so this is
 * where platform, channel, handle, status and time live — Gmail opens it
 * straight into Google Sheets, Outlook into Excel. PURE like buildPublishEmail.
 * URL column: the live post URL when http(s), else the dashboard fallback
 * (never a javascript:/data: value — safeHref-gated). Output is locked
 * byte-for-byte by publish-email.test.ts.
 */
export function buildPublishReportCsv(input: PublishEmailInput): string {
  const { postId, appUrl, targets } = input;
  const dashboardUrl = `${appUrl}/dashboard/posts/${postId}`;
  const header = [
    "platform",
    "channel",
    "handle",
    "url",
    "status",
    "published_at_utc",
    "published_at_ist",
  ];
  const rows = targets.map((t) => [
    t.platform,
    t.channelName,
    t.channelUsername ?? "",
    safeHref(t.publishedUrl) ?? dashboardUrl,
    t.status,
    csvUtc(t.publishedAt),
    csvIst(t.publishedAt),
  ]);
  return [
    header.map(csvField).join(","),
    ...rows.map((r) => r.map(csvField).join(",")),
  ].join("\n");
}
