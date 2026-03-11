"use client";

import { Bot, User, Info } from "lucide-react";
import { ContentActionBar } from "./ContentActionBar";
import { FileAttachmentList } from "./FileAttachment";
import { cn } from "~/lib/utils";

interface MessageAttachment {
  media: {
    id: string;
    url: string;
    thumbnailUrl?: string | null;
    fileName: string;
    fileType: string;
  };
}

interface ChatMessageData {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: any;
  attachments?: MessageAttachment[];
  createdAt?: string | Date;
}

interface MessageBubbleProps {
  message: ChatMessageData;
  onExecuteAction?: (action: any) => void;
  isExecuting?: boolean;
}

export function MessageBubble({ message, onExecuteAction, isExecuting }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const action = message.metadata?.action || null;
  const isContentDraft = action?.type === "generate_content";

  if (isSystem) {
    return (
      <div className="flex justify-center px-4 py-2">
        <div className="flex items-center gap-2 rounded-full bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
          <Info className="h-3 w-3" />
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex gap-3 px-4 py-3",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400"
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      {/* Message content */}
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-2.5",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted"
        )}
      >
        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <FileAttachmentList
            files={message.attachments.map((a) => a.media)}
          />
        )}

        {/* Text content */}
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {message.content}
        </div>

        {/* Content action bar for generated content */}
        {!isUser && isContentDraft && action?.payload && (
          <ContentActionBar
            content={action.payload.content as string}
            platform={action.payload.platform as string}
            onPostNow={() => onExecuteAction?.({ ...action, type: "schedule_post" })}
            isExecuting={isExecuting}
          />
        )}

        {/* Agent creation confirmation */}
        {!isUser && action?.type === "create_agent" && (
          <div className="mt-3 border-t pt-3">
            <button
              onClick={() => onExecuteAction?.(action)}
              disabled={isExecuting}
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-50"
            >
              {isExecuting ? "Creating..." : "✓ Create this agent"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
