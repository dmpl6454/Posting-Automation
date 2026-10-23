"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { ChevronLeft, ChevronRight, ImageUp, Loader2 } from "lucide-react";
import {
  FRAME_STEP_SEC,
  captureVideoFrame,
  clampSeekTime,
  formatTimecode,
} from "~/lib/video-frame";

/**
 * Cover picker for one video tile (2026-10-23): choose a FRAME from the
 * uploaded video, or upload an image as before. Either way the parent receives
 * an image File and runs it through the existing cover path.
 *
 * ⚠️ OOM rules (see CLAUDE.md, video-upload tab-OOM): a large LOCAL blob never
 * gets a <video> element (`canPreview` is false for it), and the element is
 * released with removeAttribute("src") + load() when the dialog closes — a bare
 * unmount leaves the WebKit player alive until GC.
 */
export function VideoCoverPicker({
  open,
  videoUrl,
  canPreview,
  onOpenChange,
  onPickImage,
}: {
  open: boolean;
  videoUrl: string | null;
  /** False for a large local file: no media element may be created for it. */
  canPreview: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the captured frame or the uploaded image; the parent attaches it. */
  onPickImage: (file: File) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  // Fresh state for each video / each opening.
  useEffect(() => {
    if (!open) return;
    setDuration(0);
    setTime(0);
    setSeeking(false);
    setReady(false);
    setLoadError(false);
    setCaptureError(null);
    setCapturing(false);
  }, [open, videoUrl]);

  // Release the media element when the dialog closes or the video changes.
  useEffect(() => {
    const el = videoRef.current;
    return () => {
      if (!el) return;
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, [open, videoUrl]);

  const seekTo = (t: number) => {
    const el = videoRef.current;
    if (!el) return;
    const target = clampSeekTime(t, duration);
    setTime(target);
    setCaptureError(null);
    setSeeking(true);
    el.currentTime = target;
  };

  const captureFrame = async () => {
    const el = videoRef.current;
    if (!el) return;
    setCapturing(true);
    setCaptureError(null);
    const result = await captureVideoFrame(el);
    setCapturing(false);
    if (!result.ok) {
      setCaptureError(result.reason);
      return;
    }
    onPickImage(result.file);
    onOpenChange(false);
  };

  const showPlayer = open && canPreview && !!videoUrl && !loadError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[92dvh] max-w-lg flex-col overflow-hidden"
        // An outside click must not throw away a frame the user scrubbed to.
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-none">
          <DialogTitle>Video cover</DialogTitle>
          <DialogDescription>
            Pick a moment from your video to use as the cover, or upload an image instead.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {showPlayer ? (
            <>
              <div className="relative overflow-hidden rounded-md border bg-black">
                <video
                  ref={videoRef}
                  // Same-origin /media/ in production; CORS-enabled MinIO locally.
                  // Without this the canvas would be tainted and capture would fail.
                  crossOrigin="anonymous"
                  src={videoUrl ?? undefined}
                  className="mx-auto max-h-[50dvh] w-full object-contain"
                  muted
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration;
                    setDuration(Number.isFinite(d) ? d : 0);
                    // Show the opening frame instead of a blank box (Safari
                    // paints nothing until a seek has completed).
                    setSeeking(true);
                    e.currentTarget.currentTime = 0.001;
                  }}
                  onSeeked={(e) => {
                    setSeeking(false);
                    setReady(true);
                    setTime(e.currentTarget.currentTime);
                  }}
                  onError={() => setLoadError(true)}
                />
                {(!ready || seeking) && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-white drop-shadow" />
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <input
                  type="range"
                  aria-label="Position in the video"
                  min={0}
                  max={duration > 0 ? duration : 0}
                  step={FRAME_STEP_SEC}
                  value={time}
                  disabled={!ready || duration <= 0}
                  onChange={(e) => seekTo(Number(e.target.value))}
                  className="w-full accent-primary"
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {formatTimecode(time)} / {formatTimecode(duration)}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={!ready}
                      onClick={() => seekTo(time - FRAME_STEP_SEC)}
                      title="Back one frame"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={!ready}
                      onClick={() => seekTo(time + FRAME_STEP_SEC)}
                      title="Forward one frame"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              {loadError
                ? "This video can't be played in your browser, so a frame can't be picked here. Upload an image for the cover instead."
                : "This video is too large to preview here. Upload an image for the cover instead."}
            </p>
          )}

          {captureError && <p className="text-sm text-destructive">{captureError}</p>}

          <p className="text-xs text-muted-foreground">
            Used as the cover on Instagram Reels, Facebook and YouTube. YouTube&apos;s Shorts feed ignores
            custom covers; yours still shows in the channel grid and search.
          </p>
        </div>

        <DialogFooter className="flex-none gap-2 border-t pt-3 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
            <ImageUp className="mr-1.5 h-4 w-4" />
            Upload an image instead
          </Button>
          {showPlayer && (
            <Button type="button" onClick={captureFrame} disabled={!ready || seeking || capturing}>
              {capturing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Use this frame
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            // Broad on purpose: prepareThumbnail converts any decodable image.
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              onPickImage(f);
              onOpenChange(false);
            }}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
