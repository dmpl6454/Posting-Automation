/**
 * apps/web/scripts/list-fb-user-pages.ts
 *
 * One-off export: list every Facebook Page the caller's Facebook account
 * administers (NOT just Pages already connected as Channels in
 * PostAutomation) — id, name, category, URL, and follower count.
 *
 * Reuses a Facebook USER access token already stored in Channel.metadata
 * .userAccessToken (encrypted; written at connect time — see
 * apps/web/app/api/oauth/callback/[provider]/route.ts). No re-auth needed.
 *
 * Cost: `me/accounts` paginated at limit=100 — for 500 pages that's ~5
 * Graph API calls total. `fan_count` (followers) rides on the SAME call,
 * zero extra cost.
 *
 * Output: CSV on stdout (id,name,category,url,followers). Diagnostics go
 * to stderr so `> file.csv` redirection captures only clean CSV data.
 *
 * ⚠️ LOCATION MATTERS: this script lives under apps/web/scripts/, NOT the
 * repo-root scripts/ dir. pnpm's isolated node_modules layout means
 * `@postautomation/db` only resolves from directories that declare it as a
 * direct dependency — apps/web/node_modules/@postautomation/db is a real
 * symlink, but there is no root /app/node_modules/@postautomation/* at all.
 * A script under root scripts/ throws MODULE_NOT_FOUND for any
 * @postautomation/* import; verified against the container 2026-08-19.
 *
 * Usage (from the production server, run from the apps/web working dir so
 * the workspace symlinks resolve):
 *   docker exec postautomation-web-1 sh -c \
 *     'cd /app/apps/web && NODE_PATH=/app/packages/db/node_modules \
 *      /app/packages/db/node_modules/.bin/tsx scripts/list-fb-user-pages.ts' \
 *     > fb-pages.csv
 */

import { prisma, decryptToken } from "@postautomation/db";

const GRAPH_API_VERSION = "v18.0";
const LIMIT = 100;
// Safety cap on pagination depth (not on follower counts) — a runaway
// cursor loop should stop rather than paginate forever.
const MAX_PAGES_TO_FOLLOW = 50;

interface FbPageRow {
  id: string;
  name: string;
  category: string;
  url: string;
  followers: number | string;
}

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function main() {
  // Find any active Facebook channel with a stored user access token.
  // Filtering in JS (not a Prisma JSON-path query) keeps this robust across
  // Prisma versions and avoids depending on the exact metadata shape.
  const channels = await prisma.channel.findMany({
    where: { platform: "FACEBOOK", isActive: true, disconnectedAt: null },
    orderBy: { updatedAt: "desc" },
    select: { id: true, organizationId: true, metadata: true },
  });

  const withToken = channels.find(
    (c) => c.metadata && typeof c.metadata === "object" && (c.metadata as any).userAccessToken
  );

  if (!withToken) {
    console.error(
      "No Facebook channel with a stored userAccessToken was found. " +
        "Connect at least one Facebook Page through PostAutomation first."
    );
    process.exit(1);
  }

  const encryptedToken = (withToken.metadata as any).userAccessToken as string;
  const userToken = decryptToken(encryptedToken);
  if (!userToken) {
    console.error("Failed to decrypt the stored userAccessToken.");
    process.exit(1);
  }

  console.error(
    `Using Facebook user token from channel ${withToken.id} (org ${withToken.organizationId})`
  );

  const rows: FbPageRow[] = [];
  let url: string | null =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts` +
    `?fields=id,name,category,link,fan_count&limit=${LIMIT}&access_token=${userToken}`;
  let pageRequests = 0;

  while (url && pageRequests < MAX_PAGES_TO_FOLLOW) {
    pageRequests++;
    const res = await fetch(url);
    const data: any = await res.json();

    if (!res.ok) {
      console.error(`Graph API error on request ${pageRequests}: ${JSON.stringify(data)}`);
      break;
    }

    for (const p of data.data || []) {
      rows.push({
        id: p.id,
        name: p.name || "",
        category: p.category || "",
        url: p.link || `https://www.facebook.com/${p.id}`,
        followers: p.fan_count ?? "",
      });
    }

    url = data.paging?.next || null;
    // Polite pacing between paginated calls — this is well under any rate
    // limit, but there is no reason to hammer the endpoint back-to-back.
    if (url) await new Promise((r) => setTimeout(r, 400));
  }

  console.error(
    `Fetched ${rows.length} page(s) across ${pageRequests} paginated request(s).`
  );

  console.log(["id", "name", "category", "url", "followers"].join(","));
  for (const r of rows) {
    console.log(
      [csvEscape(r.id), csvEscape(r.name), csvEscape(r.category), csvEscape(r.url), csvEscape(r.followers)].join(",")
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
