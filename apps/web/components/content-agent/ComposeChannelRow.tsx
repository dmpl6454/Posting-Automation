"use client";

import { memo } from "react";
import { Check } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { ChannelAvatar } from "~/components/channel-avatar";

/**
 * One row of Compose's channel picker (2026-11-10).
 *
 * Memoized because the picker lives inside ComposeTab, which re-renders on
 * every keystroke in the caption box. With ~500 channels in a workspace that
 * meant rebuilding 500 rows per keystroke while only ~5 are visible. With
 * `memo` and a stable `onToggle`, a row re-renders only when its own channel,
 * selection or "recent" flag changes.
 *
 * `content-visibility: auto` lets the browser skip layout and paint for rows
 * scrolled out of the picker's box; `contain-intrinsic-size` reserves their
 * height so the scrollbar does not jump.
 */
export interface ComposeChannelRowChannel {
  id: string;
  name: string;
  username?: string | null;
  avatar?: string | null;
  platform: string;
  /** Meta ended this channel's session — posts fail until it is reconnected. */
  publishBlocked?: boolean;
}

export const ComposeChannelRow = memo(function ComposeChannelRow({
  channel,
  isSelected,
  isRecent,
  onToggle,
}: {
  channel: ComposeChannelRowChannel;
  isSelected: boolean;
  isRecent: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(channel.id)}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors [contain-intrinsic-size:auto_44px] [content-visibility:auto] hover:bg-muted/50 ${
        isSelected ? "bg-primary/5" : ""
      }`}
    >
      <div
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          isSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30"
        }`}
      >
        {isSelected && <Check className="h-3 w-3" />}
      </div>
      <ChannelAvatar
        avatar={channel.avatar}
        name={channel.name}
        className="h-6 w-6 shrink-0"
        fallbackClassName="text-[9px]"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">{channel.name}</p>
        {channel.username && (
          <p className="truncate text-xs leading-tight text-muted-foreground">@{channel.username}</p>
        )}
      </div>
      <Badge variant="outline" className="shrink-0 text-[9px]">
        {channel.platform}
      </Badge>
      {channel.publishBlocked && (
        <Badge
          variant="outline"
          className="shrink-0 border-red-500/50 px-1 py-0 text-[9px] text-red-600 dark:text-red-400"
          title="This channel's session ended. Posts to it will fail until you reconnect it on the Channels page."
        >
          Reconnect
        </Badge>
      )}
      {isRecent && (
        <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[9px]">
          Recent
        </Badge>
      )}
    </button>
  );
});
