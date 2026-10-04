"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import type { ArticleTaxonomySelection } from "~/lib/wordpress-article";

/**
 * Categories + tags of ONE connected WordPress site, for Compose's Article mode.
 *
 * Term ids are per site, so each selected site gets its own picker and its own
 * selection (keyed by channel id; the server re-keys by site URL). Loaded
 * lazily through `channel.wordpressTaxonomies` and cached for five minutes —
 * a taxonomy rarely changes mid-draft, and every read spends the site's own
 * resources.
 */
export function ArticleTaxonomyPicker({
  channelId,
  siteName,
  selection,
  onChange,
}: {
  channelId: string;
  siteName: string;
  selection: ArticleTaxonomySelection;
  onChange: (next: ArticleTaxonomySelection) => void;
}) {
  const [filter, setFilter] = useState("");
  const query = trpc.channel.wordpressTaxonomies.useQuery(
    { channelId },
    { staleTime: 5 * 60 * 1000, retry: false }
  );

  const toggle = (kind: "categoryIds" | "tagIds", id: number) => {
    const has = selection[kind].includes(id);
    onChange({ ...selection, [kind]: has ? selection[kind].filter((x) => x !== id) : [...selection[kind], id] });
  };

  const q = filter.trim().toLowerCase();
  const categories = (query.data?.categories ?? []).filter((c) => !q || c.name.toLowerCase().includes(q));
  const tags = (query.data?.tags ?? []).filter((t) => !q || t.name.toLowerCase().includes(q));
  const picked = selection.categoryIds.length + selection.tagIds.length;

  return (
    <div className="rounded-md border p-3" data-testid="article-taxonomy-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold">{siteName}</span>
        <span className="text-[11px] text-muted-foreground">
          {picked > 0 ? `${picked} selected` : "Nothing selected"}
        </span>
      </div>
      {query.isLoading ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading categories and tags…
        </div>
      ) : query.error ? (
        <p className="mt-2 text-xs text-destructive">{humanizeError(query.error)}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {(query.data?.categories.length ?? 0) + (query.data?.tags.length ?? 0) > 12 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="h-7 w-full rounded border bg-background px-2 text-xs"
            />
          )}
          <TermGroup label="Categories" kind="categoryIds" items={categories} selected={selection.categoryIds} onToggle={toggle} emptyText="This site has no categories." />
          <TermGroup label="Tags" kind="tagIds" items={tags} selected={selection.tagIds} onToggle={toggle} emptyText="No existing tags — add new ones above." />
        </div>
      )}
    </div>
  );
}

function TermGroup({
  label,
  kind,
  items,
  selected,
  onToggle,
  emptyText,
}: {
  label: string;
  kind: "categoryIds" | "tagIds";
  items: Array<{ id: number; name: string; count: number }>;
  selected: number[];
  onToggle: (kind: "categoryIds" | "tagIds", id: number) => void;
  emptyText: string;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
          {items.map((t) => {
            const on = selected.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(kind, t.id)}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                title={t.count ? `${t.count} posts` : undefined}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
