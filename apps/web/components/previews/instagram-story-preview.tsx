"use client";

import { PreviewMedia, type MediaKind } from "./preview-media";
import { Avatar, AvatarImage, AvatarFallback } from "~/components/ui/avatar";

export interface InstagramStoryPreviewProps {
  mediaUrl?: string;
  mediaKind?: MediaKind;
  mentions: string[];
  /** Selected Instagram accounts — the first fills the header, the rest are counted. */
  accounts: Array<{ name: string; username?: string | null; avatar?: string | null }>;
  /** The optional note kept with the post. Instagram never displays it. */
  note?: string;
}

function initials(name: string): string {
  return (
    name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || "IG"
  );
}

/**
 * A 9:16 story frame, rendered INSTEAD of PostPreviewSwitcher while Compose is in
 * Story mode — a story is not a feed post, and showing one as a square card with
 * a caption misrepresents what will be published.
 *
 * ⚠️ Media goes through PreviewMedia, never a bare tag. That component is the one
 * place allowed to decide image-vs-video, and it fails toward `<video>`: an
 * `<img>` pointed at a video makes WebKit ingest the whole file and kills the tab
 * (measured +1.57GB on a 1.6GB clip).
 *
 * ⚠️ No `poster` is passed. Custom covers are a Reels feature; Meta rejects
 * `cover_url` on a STORIES container, so a cover set in Post mode must not appear
 * here — the preview would promise something the publish drops.
 */
export function InstagramStoryPreview({
  mediaUrl,
  mediaKind,
  mentions,
  accounts,
  note,
}: InstagramStoryPreviewProps) {
  const first = accounts[0];
  const username = first?.username || first?.name?.toLowerCase().replace(/\s+/g, "") || "yourname";

  return (
    <div className="space-y-2">
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[300px] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-white shadow-lg">
        {/* Story progress bar */}
        <div className="absolute left-2 right-2 top-2 z-20 h-0.5 rounded-full bg-white/30">
          <div className="h-full w-1/3 rounded-full bg-white" />
        </div>

        {/* Header */}
        <div className="absolute left-2 right-2 top-4 z-20 flex items-center gap-2">
          <Avatar className="h-7 w-7 border border-white/60">
            {first?.avatar ? <AvatarImage src={first.avatar} alt={username} /> : null}
            <AvatarFallback className="bg-zinc-700 text-[10px] text-white">
              {initials(first?.name ?? "")}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold drop-shadow">{username}</span>
          <span className="flex-none text-[10px] text-white/70">now</span>
        </div>

        {/* Media */}
        {mediaUrl ? (
          <PreviewMedia url={mediaUrl} kind={mediaKind} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-white/60">
            Add one image or video to preview your story
          </div>
        )}

        {/* Mentions — Instagram renders a sticker-less mention as plain @handle text */}
        {mentions.length > 0 && (
          <div className="absolute bottom-10 left-3 right-3 z-20 flex flex-wrap gap-1.5">
            {mentions.map((m) => (
              <span
                key={m}
                className="rounded-md bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-zinc-900 shadow"
              >
                @{m}
              </span>
            ))}
          </div>
        )}

        {/* Reply bar */}
        <div className="absolute bottom-2 left-3 right-3 z-20 rounded-full border border-white/50 px-3 py-1.5 text-[11px] text-white/70">
          Send message
        </div>
      </div>

      <p className="text-center text-[10px] text-muted-foreground">
        {accounts.length > 1 ? `Publishes to ${accounts.length} Instagram accounts · ` : ""}
        Preview only · disappears 24 hours after publishing
      </p>
      {note ? (
        <p className="text-center text-[10px] italic text-muted-foreground">
          Note (not shown on the story): {note.slice(0, 80)}
          {note.length > 80 ? "…" : ""}
        </p>
      ) : null}
    </div>
  );
}
