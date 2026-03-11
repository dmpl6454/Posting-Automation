"use client";

import { Button } from "~/components/ui/button";
import { Copy, Send, Calendar, Check } from "lucide-react";
import { useState } from "react";

interface ContentActionBarProps {
  content: string;
  platform?: string;
  onPostNow?: () => void;
  onSchedule?: () => void;
  isExecuting?: boolean;
}

export function ContentActionBar({
  content,
  platform,
  onPostNow,
  onSchedule,
  isExecuting,
}: ContentActionBarProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-3 flex items-center gap-2 border-t pt-3">
      {onPostNow && (
        <Button
          size="sm"
          variant="default"
          className="gap-1.5"
          onClick={onPostNow}
          disabled={isExecuting}
        >
          <Send className="h-3.5 w-3.5" />
          Post Now
        </Button>
      )}
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
