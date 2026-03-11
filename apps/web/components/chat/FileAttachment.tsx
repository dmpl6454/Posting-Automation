"use client";

import { Paperclip, X, Image as ImageIcon, FileText } from "lucide-react";

interface AttachmentFile {
  id: string;
  url: string;
  thumbnailUrl?: string | null;
  fileName: string;
  fileType: string;
}

export function FileAttachment({
  file,
  onRemove,
}: {
  file: AttachmentFile;
  onRemove?: () => void;
}) {
  const isImage = file.fileType.startsWith("image/");

  return (
    <div className="group relative inline-flex items-center gap-2 rounded-lg border bg-muted/50 p-2 text-sm">
      {isImage && file.thumbnailUrl ? (
        <img
          src={file.thumbnailUrl || file.url}
          alt={file.fileName}
          className="h-10 w-10 rounded object-cover"
        />
      ) : isImage ? (
        <ImageIcon className="h-5 w-5 text-muted-foreground" />
      ) : (
        <FileText className="h-5 w-5 text-muted-foreground" />
      )}
      <span className="max-w-[120px] truncate text-xs">{file.fileName}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-destructive p-0.5 text-destructive-foreground group-hover:block"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function FileAttachmentList({
  files,
  onRemove,
}: {
  files: AttachmentFile[];
  onRemove?: (id: string) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-1 py-2">
      {files.map((file) => (
        <FileAttachment
          key={file.id}
          file={file}
          onRemove={onRemove ? () => onRemove(file.id) : undefined}
        />
      ))}
    </div>
  );
}
