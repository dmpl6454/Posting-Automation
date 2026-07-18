/**
 * Publish-notification email builder (redesign 2026-07-17).
 *
 * PURE — no prisma/nodemailer — so the template is unit-testable
 * (publish-email.test.ts, run via root vitest). The worker's
 * sendPublishReportEmail resolves the recipient (the post CREATOR — owner
 * decision 2026-07-17; previously every org OWNER/ADMIN was emailed) and
 * hands the data here.
 *
 * SECURITY: the old inline template interpolated post content and platform
 * URLs into HTML RAW. Post content is user-controlled → every dynamic value
 * now goes through escapeHtml, and URLs must be http(s) or they render as
 * plain text (no javascript: hrefs).
 */

export interface PublishEmailTarget {
  platform: string;
  channelName: string;
  channelUsername: string | null;
  status: string; // "PUBLISHED" | "FAILED" | ...
  publishedUrl: string | null;
  publishedAt: Date | string | null;
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

  const titleRaw = postContent.split("\n")[0]?.slice(0, 60) || "Untitled post";
  const titleSuffix = (postContent.split("\n")[0]?.length ?? 0) > 60 ? "…" : "";
  const subject =
    published.length === targets.length
      ? `✅ Published: "${titleRaw}${titleSuffix}" — ${published.length}/${targets.length} channel${targets.length === 1 ? "" : "s"}`
      : published.length > 0
        ? `⚠️ Partially published: "${titleRaw}${titleSuffix}" — ${published.length}/${targets.length} channels`
        : `❌ Publish failed: "${titleRaw}${titleSuffix}" — 0/${targets.length} channel${targets.length === 1 ? "" : "s"}`;

  const dashboardUrl = `${appUrl}/dashboard/posts/${postId}`;

  const row = (t: PublishEmailTarget) => {
    const ok = t.status === "PUBLISHED";
    const href = safeHref(t.publishedUrl);
    const channelLabel = `${escapeHtml(t.channelName)}${t.channelUsername ? ` <span style="color:#a1a1aa;">@${escapeHtml(t.channelUsername)}</span>` : ""}`;
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;white-space:nowrap;">${ok ? "✅" : "❌"} ${escapeHtml(t.platform)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">${channelLabel}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;font-size:12px;color:#52525b;white-space:nowrap;">${escapeHtml(fmtWhen(t.publishedAt))}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">
        ${
          ok
            ? href
              ? // Anchor stays clickable; the raw URL is ALSO shown as copyable
                // text below it (owner ask 2026-07-18 — recipients need to see
                // and copy the actual link, not just "View post").
                `<a href="${escapeHtml(href)}" style="color:#2563eb;text-decoration:none;">View post</a><div style="font-size:11px;color:#a1a1aa;word-break:break-all;">${escapeHtml(href)}</div>`
              : `<a href="${escapeHtml(dashboardUrl)}" style="color:#2563eb;text-decoration:none;">Open in dashboard</a>`
            : '<span style="color:#991b1b;">failed</span>'
        }
      </td>
    </tr>`;
  };

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#18181b;padding:24px 32px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;">PostAutomation</h1>
    </div>
    <div style="padding:32px;">
      <h2 style="margin:0 0 8px;font-size:18px;color:#18181b;">${published.length === targets.length ? "Your post is live" : published.length > 0 ? "Your post partially published" : "Your post could not be published"}</h2>
      <p style="color:#3f3f46;line-height:1.6;margin:0 0 4px;"><strong>${escapeHtml(postContent.slice(0, 140))}${postContent.length > 140 ? "…" : ""}</strong></p>
      <p style="color:#71717a;font-size:13px;margin:0 0 20px;">${published.length} published${failed.length ? `, ${failed.length} failed` : ""} · ${targets.length} channel${targets.length === 1 ? "" : "s"}</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e4e4e7;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#f4f4f5;">
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#71717a;font-weight:500;">Platform</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#71717a;font-weight:500;">Channel</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#71717a;font-weight:500;">Published at</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#71717a;font-weight:500;">Link</th>
          </tr>
        </thead>
        <tbody>${targets.map(row).join("")}</tbody>
      </table>
      <div style="text-align:center;margin:24px 0 0;">
        <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:500;">View in Dashboard</a>
      </div>
    </div>
    <div style="padding:16px 32px;background:#f4f4f5;text-align:center;font-size:12px;color:#71717a;">
      <p style="margin:0;">&copy; ${new Date().getFullYear()} PostAutomation. All rights reserved.</p>
    </div>
  </div>
</body></html>`;

  const text = [
    subject,
    "",
    ...targets.map(
      (t) =>
        `${t.status === "PUBLISHED" ? "[OK]" : "[FAILED]"} ${t.platform} · ${t.channelName}${t.channelUsername ? ` (@${t.channelUsername})` : ""} · ${fmtWhen(t.publishedAt)} · ${safeHref(t.publishedUrl) ?? dashboardUrl}`
    ),
    "",
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
 * Spreadsheet-ready report of the same per-channel rows the email shows.
 * Attached to the publish email as a .csv so recipients get the links with
 * structure (platform, channel, url, …) in one click — Gmail opens it straight
 * into Google Sheets, Outlook into Excel. PURE like buildPublishEmail.
 * URL column mirrors the email's Link cell: live post URL when http(s), else
 * the dashboard fallback (never a javascript:/data: value — safeHref-gated).
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
