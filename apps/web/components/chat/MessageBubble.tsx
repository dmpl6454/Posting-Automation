"use client";

import { Bot, User, Info, ImageIcon, Zap, CheckCircle2 } from "lucide-react";
import { ContentActionBar } from "./ContentActionBar";
import { FileAttachmentList } from "./FileAttachment";
import { cn } from "~/lib/utils";
import { actionKey } from "~/lib/chat-action-key";

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
  /** A1: set of actionKey values that have already been executed — disables the
   *  button permanently and shows a "Done" badge so double-click can't fire a
   *  second LIVE post. Mirrors super-agent/page.tsx executedActionIds pattern. */
  executedActionIds?: Set<string>;
}

export function MessageBubble({ message, onExecuteAction, isExecuting, executedActionIds }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const action = message.metadata?.action || null;
  const isContentDraft = action?.type === "generate_content";
  const isNewsImage = action?.type === "generate_news_image";
  const isCreateAgent = action?.type === "create_agent";
  // Any other action type (publish_now, schedule_post, bulk_schedule, ...)
  // renders a generic explicit confirm button below — NEVER auto-executed
  // (CLAUDE.md invariant: publish_now requires an explicit user click).
  const isGenericAction = !!action && !isContentDraft && !isNewsImage && !isCreateAgent;

  // A1: compute the stable lock key for THIS message's action. The message.id
  // passed here is the persisted DB id (stable after the first getThread load),
  // and action.idempotencyKey is the server-stamped UUID from the stream route.
  // This MUST match the key produced inside executeAction in use-chat-stream.ts.
  const thisActionKey = action ? actionKey(message.id, action.idempotencyKey) : "";
  const isActionExecuted = !!(action && executedActionIds?.has(thisActionKey));

  if (isSystem) {
    // Special rendering for system messages with generated news images
    if (message.metadata?.type === "news_image_generated" && message.attachments?.[0]) {
      return (
        <div className="flex flex-col items-center gap-2 px-4 py-3">
          <div className="flex items-center gap-2 rounded-full bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
            <ImageIcon className="h-3 w-3" />
            {message.content}
          </div>
          <div className="max-w-md">
            <img
              src={message.attachments[0].media.url}
              alt={message.metadata.headline || "News image"}
              className="rounded-lg w-full shadow-md"
              style={{ maxHeight: 400 }}
            />
            <p className="mt-1.5 text-center text-xs text-muted-foreground">
              {message.metadata.headline}
            </p>
          </div>
        </div>
      );
    }

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
            onPostNow={() => onExecuteAction?.({ ...action, type: "publish_now" })}
            isExecuting={isExecuting}
          />
        )}

        {/* Agent creation confirmation */}
        {!isUser && action?.type === "create_agent" && (
          <div className="mt-3 border-t pt-3">
            {isActionExecuted ? (
              <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 w-fit">
                <CheckCircle2 className="h-3 w-3" />
                Done
              </span>
            ) : (
              <button
                onClick={() => onExecuteAction?.(action)}
                disabled={isExecuting || isActionExecuted}
                className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-50"
              >
                {isExecuting ? "Creating..." : "✓ Create this agent"}
              </button>
            )}
          </div>
        )}

        {/* News image generation */}
        {!isUser && isNewsImage && action?.payload && (
          <div className="mt-3 border-t pt-3 space-y-3">
            {isActionExecuted ? (
              <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 w-fit">
                <CheckCircle2 className="h-3 w-3" />
                Done
              </span>
            ) : (
              <button
                onClick={() => onExecuteAction?.(action)}
                disabled={isExecuting || isActionExecuted}
                className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-rose-500 to-orange-500 px-4 py-2 text-sm font-medium text-white transition-all hover:from-rose-600 hover:to-orange-600 disabled:opacity-50"
              >
                <ImageIcon className="h-4 w-4" />
                {isExecuting ? "Generating image..." : "Generate News Image"}
              </button>
            )}
            {action.payload.content && (
              <p className="text-xs text-muted-foreground">
                Platform: {(action.payload.platform as string) || "Not specified"} •
                Style: {(action.payload.imageStyle as string) === "ai_generated" ? "AI Generated" : "News Card"}
              </p>
            )}
          </div>
        )}

        {/* Generic action confirm (publish_now / schedule_post / ...) — always
            an explicit button; publish_now additionally shows an irreversibility
            warning. Replaces the removed auto-execute (which published live
            posts with zero review — CLAUDE.md audit invariant 2026-06-06). */}
        {!isUser && isGenericAction && (
          <div className="mt-3 border-t pt-3 space-y-2">
            {action.type === "publish_now" && !isActionExecuted && (
              <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                <Info className="h-3 w-3 shrink-0" />
                This will publish immediately to your selected channels. It cannot be undone.
              </div>
            )}
            {isActionExecuted ? (
              <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 w-fit">
                <CheckCircle2 className="h-3 w-3" />
                Done
              </span>
            ) : (
              <button
                onClick={() => onExecuteAction?.(action)}
                disabled={isExecuting || isActionExecuted}
                className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-50"
              >
                {isExecuting
                  ? "Working..."
                  : action.type === "publish_now"
                    ? "Publish now"
                    : `Confirm: ${String(action.type).replace(/_/g, " ")}`}
              </button>
            )}
          </div>
        )}

        {/* Display attached news image (after generation) */}
        {message.metadata?.type === "news_image_generated" && message.attachments?.[0] && (
          <div className="mt-3">
            <img
              src={message.attachments[0].media.url}
              alt={message.metadata.headline || "News image"}
              className="rounded-lg max-w-full"
              style={{ maxHeight: 400 }}
            />
          </div>
        )}

        {/* "Answered by" provider chip — only for assistant messages with a known provider */}
        {!isUser && message.metadata?.provider && message.id !== "streaming" && (
          <div className="mt-2 flex items-center gap-1 opacity-60">
            <Zap className="h-2.5 w-2.5" />
            <span className="text-[10px]">
              {({
                openai:    "GPT-4",
                anthropic: "Claude",
                gemini:    "Gemini",
                gemma4:    "Gemma 4",
                grok:      "Grok 3",
                deepseek:  "DeepSeek",
              } as Record<string, string>)[message.metadata.provider as string] ?? message.metadata.provider}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
