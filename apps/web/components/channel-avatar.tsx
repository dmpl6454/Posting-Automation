"use client";

import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";

interface ChannelAvatarProps {
  avatar?: string | null;
  name?: string | null;
  /** Size/positioning overrides; defaults to h-9 w-9 */
  className?: string;
  /** Overrides for the initials fallback text (defaults scale with h-9) */
  fallbackClassName?: string;
}

/**
 * Channel profile picture with a guaranteed fallback: platform CDN avatar
 * URLs expire (IG/FB signed URLs) or 404 (Twitter photo changes), so a dead
 * URL must degrade to initials instead of the browser broken-image icon.
 */
export function ChannelAvatar({
  avatar,
  name,
  className,
  fallbackClassName,
}: ChannelAvatarProps) {
  const [failed, setFailed] = useState(false);

  // A new URL (e.g. after refresh/re-cache) deserves a fresh attempt.
  useEffect(() => {
    setFailed(false);
  }, [avatar]);

  if (avatar && !failed) {
    return (
      <img
        src={avatar}
        alt={name || "Channel"}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn("h-9 w-9 rounded-full object-cover", className)}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground",
        className,
        fallbackClassName
      )}
    >
      {(name || "?").charAt(0).toUpperCase()}
    </div>
  );
}
