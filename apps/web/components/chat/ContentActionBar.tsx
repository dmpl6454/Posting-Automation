"use client";

import { Button } from "~/components/ui/button";
import { Copy, PenLine, Calendar, Check } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

interface ContentActionBarProps {
  content: string;
  platform?: string;
  /** @deprecated — drafts are now routed to the Composer; kept for API compat. */
  onPostNow?: () => void;
  onSchedule?: () => void;
  isExecuting?: boolean;
}

export function ContentActionBar({
  content,
  platform,
  onSchedule,
  isExecuting,
}: ContentActionBarProps) {
  const [copied, setCopied] = useState(false);
  const router = useRouter();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /** Navigate to the Compose tab pre-filled with the draft content.
   *  The Compose tab has channel selection + schedule / publish — everything
   *  needed to actually post. Avoids the empty-channelIds BAD_REQUEST that
   *  "Post Now" → publish_now → assertChannelsOwned always threw because the
   *  generate_content action payload never carries channelIds. */
  const handleOpenInComposer = () => {
    const url = `/dashboard/content-agent?tab=compose&content=${encodeURIComponent(content)}`;
    router.push(url);
  };

  return (
    <div className="mt-3 flex items-center gap-2 border-t pt-3">
      <Button
        size="sm"
        variant="default"
        className="gap-1.5"
        onClick={handleOpenInComposer}
        disabled={isExecuting}
        title="Open in Composer to pick channels and publish"
      >
        <PenLine className="h-3.5 w-3.5" />
        Open in Composer
      </Button>
      {onSchedule && (
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={onSchedule}
          disabled={isExecuting}
        >
          <Calendar className="h-3.5 w-3.5" />
          Schedule
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="gap-1.5"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </Button>
      {platform && (
        <span className="ml-auto text-xs text-muted-foreground">
          {platform}
        </span>
      )}
    </div>
  );
}
