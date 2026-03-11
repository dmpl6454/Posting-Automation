export interface RssItem {
  guid: string;
  title: string;
  link: string;
  summary: string;
  published: Date | null;
}

export function extractTag(xml: string, tag: string): string {
  const cdataRegex = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
    "i"
  );
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch && cdataMatch[1]) return cdataMatch[1].trim();

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(regex);
  if (match && match[1]) {
    return match[1].replace(/<[^>]+>/g, "").trim();
  }
  return "";
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];

  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1] ?? "";
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const guid = extractTag(block, "guid") || link || title;
    const summary =
      extractTag(block, "description") ||
      extractTag(block, "content:encoded") ||
      "";
    const pubDate = extractTag(block, "pubDate");

    if (guid && title) {
      items.push({
        guid,
        title,
        link: link || "",
        summary: summary.slice(0, 2000),
        published: pubDate ? new Date(pubDate) : null,
      });
    }
  }

  if (items.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1] ?? "";
      const title = extractTag(block, "title");
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/);
      const link = linkMatch ? (linkMatch[1] ?? "") : extractTag(block, "link");
      const guid = extractTag(block, "id") || link || title;
      const summary =
        extractTag(block, "summary") ||
        extractTag(block, "content") ||
        "";
      const updated = extractTag(block, "updated") || extractTag(block, "published");

      if (guid && title) {
        items.push({
          guid,
          title,
          link: link || "",
          summary: summary.slice(0, 2000),
          published: updated ? new Date(updated) : null,
        });
      }
    }
  }

  return items;
}
