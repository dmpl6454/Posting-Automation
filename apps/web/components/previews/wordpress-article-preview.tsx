"use client";

import { useMemo } from "react";
import { markdownToHtml, markdownToExcerpt } from "~/lib/markdown-lite";
import { PreviewMedia, type MediaKind } from "./preview-media";

export interface WordPressArticlePreviewProps {
  title: string;
  /** Markdown body — rendered with the SAME converter the publish worker uses. */
  body: string;
  excerpt?: string;
  status: "publish" | "draft" | "pending";
  /** First image = featured; the rest are appended as figures, like the publish. */
  mediaUrls?: string[];
  mediaKinds?: MediaKind[];
  /** Selected WordPress sites — the first names the masthead, the rest are counted. */
  sites: Array<{ name: string; username?: string | null }>;
  categoryNames?: string[];
  tagNames?: string[];
  timestamp?: Date;
}

/**
 * A blog-post card rendered INSTEAD of PostPreviewSwitcher while Compose is in
 * Article mode. The body HTML comes from markdown-lite, a byte-identical replica
 * of the converter the worker posts to the site with (parity-tested), so what
 * the author sees here is what WordPress receives — minus the theme.
 *
 * ⚠️ dangerouslySetInnerHTML is safe here ONLY because markdown-lite escapes the
 * input as text first and whitelists http(s)/mailto URLs. Never feed it HTML.
 *
 * ⚠️ Media goes through PreviewMedia, never a bare tag (the WebKit <img>-on-video
 * rule).
 */
export function WordPressArticlePreview(props: WordPressArticlePreviewProps) {
  const { title, body, excerpt, status, mediaUrls = [], mediaKinds = [], sites, categoryNames = [], tagNames = [], timestamp } = props;
  const html = useMemo(() => markdownToHtml(body), [body]);
  const autoExcerpt = useMemo(() => (excerpt?.trim() ? excerpt.trim() : markdownToExcerpt(body)), [excerpt, body]);
  const site = sites[0];
  const more = sites.length - 1;
  const [featured, ...rest] = mediaUrls;
  const date = (timestamp ?? new Date()).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm" data-testid="wordpress-article-preview">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2 text-[11px]">
        <span className="min-w-0 truncate font-semibold uppercase tracking-wide text-muted-foreground">
          {site ? site.name : "WordPress site"}
          {more > 0 ? ` +${more} more` : ""}
        </span>
        <span
          className={`flex-none rounded-full px-2 py-0.5 font-medium ${
            status === "publish"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
              : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
          }`}
        >
          {status === "publish" ? "Will publish" : status === "draft" ? "WordPress draft" : "Pending review"}
        </span>
      </div>
      {featured && (
        <div className="aspect-[16/9] w-full overflow-hidden bg-muted">
          <PreviewMedia url={featured} kind={mediaKinds[0]} className="h-full w-full object-cover" />
        </div>
      )}
      <div className="space-y-3 p-4">
        <h1 className="text-xl font-bold leading-tight">{title.trim() || <span className="text-muted-foreground">Untitled article</span>}</h1>
        <p className="text-[11px] text-muted-foreground">
          {date}
          {categoryNames.length > 0 ? ` · ${categoryNames.join(", ")}` : ""}
        </p>
        {autoExcerpt && <p className="text-sm italic text-muted-foreground">{autoExcerpt}</p>}
        {html ? (
          <div
            className="article-body prose prose-sm max-w-none text-[13px] leading-relaxed dark:prose-invert [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h1]:font-bold [&_h2]:font-semibold [&_h3]:font-semibold [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_code]:text-[12px] [&_a]:underline [&_img]:max-w-full [&_hr]:my-3"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Start writing the body — Markdown is supported.</p>
        )}
        {rest.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {rest.map((u, i) => (
              <div key={`${u}-${i}`} className="aspect-[4/3] overflow-hidden rounded bg-muted">
                <PreviewMedia url={u} kind={mediaKinds[i + 1]} className="h-full w-full object-cover" />
              </div>
            ))}
          </div>
        )}
        {tagNames.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {tagNames.map((t) => (
              <span key={t} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
