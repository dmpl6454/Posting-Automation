"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Paperclip, Send, Loader2 } from "lucide-react";
import { FileAttachmentList } from "./FileAttachment";
import { cn } from "~/lib/utils";

interface PendingFile {
  id: string;
  url: string;
  thumbnailUrl?: string | null;
  fileName: string;
  fileType: string;
}

interface ChatInputProps {
  onSend: (message: string, attachmentMediaIds?: string[]) => void;
  onUploadFile?: (file: File) => Promise<PendingFile | null>;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({
  onSend,
  onUploadFile,
  disabled,
  placeholder = "Type a message...",
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && pendingFiles.length === 0) return;

    onSend(trimmed, pendingFiles.map((f) => f.id));
    setText("");
    setPendingFiles([]);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, pendingFiles, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !onUploadFile) return;

    setIsUploading(true);
    for (const file of Array.from(files)) {
      const result = await onUploadFile(file);
      if (result) {
        setPendingFiles((prev) => [...prev, result]);
      }
    }
    setIsUploading(false);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removePendingFile = (id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  };

  return (
    <div className="border-t bg-background p-4">
      {/* Pending attachments */}
      {pendingFiles.length > 0 && (
        <FileAttachmentList
          files={pendingFiles}
          onRemove={removePendingFile}
        />
      )}

      <div className="flex items-end gap-2">
        {/* File upload button */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isUploading}
        >
          {isUploading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Paperclip className="h-5 w-5" />
          )}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,.pdf,.doc,.docx,.txt"
          multiple
          onChange={handleFileSelect}
        />

        {/* Text input */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-xl border bg-muted/50 px-4 py-3 text-sm",
            "placeholder:text-muted-foreground",
            "focus:outline-none focus:ring-2 focus:ring-ring",
            "disabled:opacity-50",
            "max-h-[200px]"
          )}
        />

        {/* Send button */}
        <Button
          type="button"
          size="icon"
          className="shrink-0 rounded-xl"
          onClick={handleSend}
          disabled={disabled || (!text.trim() && pendingFiles.length === 0)}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>

      <p className="mt-2 text-center text-xs text-muted-foreground">
        Press Enter to send, Shift+Enter for new line
      </p>
    </div>
  );
}
