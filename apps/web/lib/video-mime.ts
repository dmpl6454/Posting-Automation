/**
 * Video MIME normalization for upload surfaces (Compose, Media page).
 *
 * Browsers report `file.type` straight from the OS MIME registry, which is
 * patchy for video: Windows frequently reports "" for .mov/.m4v/.webm, and
 * Apple tooling reports "video/x-m4v" for .m4v even though the container is
 * plain MP4. The server upload allowlists (upload.router / media.router /
 * /api/upload) key on the reported type, so an empty or aliased type
 * hard-fails a perfectly good file before a single byte uploads. Normalize
 * what we safely can BEFORE the type gate.
 *
 * Deliberately NOT mapped: mkv/avi/wmv/flv — storage would accept the bytes,
 * but the downstream platform publishes (IG/FB URL-pull, X chunked upload)
 * reject those containers, which converts an upfront clear error into a
 * far worse publish-time failure.
 */
const EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4", // MP4 container; "video/x-m4v" is an Apple alias for it
  mov: "video/quicktime",
  qt: "video/quicktime",
  webm: "video/webm",
};

/**
 * Returns the effective upload MIME for a picked video file, or null when the
 * file is not a recognizable video (caller shows its unsupported-file toast).
 */
export function resolveVideoMime(fileName: string, reportedType: string): string | null {
  if (reportedType === "video/x-m4v") return "video/mp4";
  if (reportedType.startsWith("video/")) return reportedType;
  if (reportedType) return null; // a real, non-video type — not ours to fix
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * Wraps a File with a corrected MIME type when needed. File construction from
 * a blob part references the same immutable bytes — no copy, safe for 4GB
 * videos. Returns the original file unchanged when its type is already fine,
 * or null when the file isn't a recognizable video.
 */
export function withNormalizedVideoMime(file: File): File | null {
  const mime = resolveVideoMime(file.name, file.type);
  if (!mime) return null;
  if (mime === file.type) return file;
  return new File([file], file.name, { type: mime, lastModified: file.lastModified });
}
