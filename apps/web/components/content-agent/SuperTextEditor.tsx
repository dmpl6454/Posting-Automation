"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Film } from "lucide-react";
import {
  superTextConfigSchema,
  SUPER_TEXT_DEFAULTS,
  FONT_SIZE_PRESETS,
  WORD_COLOR_SWATCHES,
  SUPER_TEXT_FONTS,
  SUPER_TEXT_FONT_KEYS,
  DEFAULT_SUPER_TEXT_FONT,
  type SuperTextConfig,
  type SuperTextFontKey,
} from "@postautomation/super-text";
import { SuperTextFontFaces } from "./super-text-font-faces";
import { withPosterHint } from "~/lib/video-poster";
import { SuperTextStrip } from "./super-text-strip";

/**
 * Instagram-style "super text" editor: type a line (emoji welcome — the native
 * keyboard/picker inserts them as ordinary characters), tint individual words,
 * pick a size, and DRAG the strip to position it over the video.
 *
 * Everything the user sets is stored as percentages of the frame, so the strip
 * lands in the same place in the burned video regardless of resolution.
 *
 * ⚠️ Memory rules inherited from the video-upload OOM incident:
 *  - a LOCAL file over TILE_VIDEO_PREVIEW_MAX_BYTES gets a placeholder stage, never
 *    a <video> element (WebKit ingests the whole blob and kills the tab)
 *  - the aspect probe is keyed on the URL STRING and releases its element the
 *    moment metadata arrives (removeAttribute("src") + load())
 *  - an <img> must NEVER receive a video URL
 */

/** Mirrors ComposeTab's own tile threshold. */
const TILE_VIDEO_PREVIEW_MAX_BYTES = 256 * 1024 * 1024;
const MAX_CHARS = 150;

export function SuperTextEditor({
  open,
  onOpenChange,
  videoUrl,
  videoFile,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoUrl: string;
  videoFile?: File;
  initial: SuperTextConfig | null;
  onSave: (config: SuperTextConfig | null) => void;
}) {
  const [text, setText] = useState(() =>
    initial ? initial.segments.map((s) => s.text).join(" ") : ""
  );
  const [wordColors, setWordColors] = useState<Record<number, string | undefined>>(() => {
    const map: Record<number, string | undefined> = {};
    initial?.segments.forEach((s, i) => {
      if (s.color) map[i] = s.color;
    });
    return map;
  });
  const [selectedWord, setSelectedWord] = useState<number | null>(null);
  const [stripColor, setStripColor] = useState(initial?.stripColor ?? SUPER_TEXT_DEFAULTS.stripColor);
  const [textColor, setTextColor] = useState(initial?.textColor ?? SUPER_TEXT_DEFAULTS.textColor);
  const [fontSizePct, setFontSizePct] = useState(initial?.fontSizePct ?? SUPER_TEXT_DEFAULTS.fontSizePct);
  const [font, setFont] = useState<SuperTextFontKey>(initial?.font ?? DEFAULT_SUPER_TEXT_FONT);
  const [xPct, setXPct] = useState(initial?.xPct ?? SUPER_TEXT_DEFAULTS.xPct);
  const [yPct, setYPct] = useState(initial?.yPct ?? SUPER_TEXT_DEFAULTS.yPct);
  const [aspect, setAspect] = useState<number | null>(null);
  const [stageWidth, setStageWidth] = useState(0);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const skipInlineVideo = !!videoFile && videoFile.size > TILE_VIDEO_PREVIEW_MAX_BYTES;

  // Measure the video's aspect ratio so the stage matches the real frame — a
  // strip dragged onto a 16:9 stage must not land elsewhere on a 9:16 video.
  // Keyed on the URL STRING (never an object/array identity).
  useEffect(() => {
    if (!open || !videoUrl) return;
    let el: HTMLVideoElement | null = document.createElement("video");
    el.preload = "metadata";
    el.muted = true;
    const release = () => {
      if (!el) return;
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute("src");
      el.load();
      el = null;
    };
    el.onloadedmetadata = () => {
      if (el && el.videoWidth && el.videoHeight) setAspect(el.videoWidth / el.videoHeight);
      release();
    };
    el.onerror = release;
    el.src = videoUrl;
    return release;
  }, [open, videoUrl]);

  // Track the rendered stage width so the preview font scales like the burn.
  useEffect(() => {
    if (!open) return;
    const node = stageRef.current;
    if (!node) return;
    setStageWidth(node.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setStageWidth(w);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [open, aspect]);

  const previewConfig = useMemo<SuperTextConfig | null>(() => {
    if (words.length === 0) return null;
    const candidate = {
      version: 1 as const,
      segments: words.map((w, i) => ({ text: w, ...(wordColors[i] ? { color: wordColors[i] } : {}) })),
      stripColor,
      textColor,
      xPct,
      yPct,
      fontSizePct,
      // Omitted when classic: an absent key keeps JSON.stringify — and so the
      // worker's S3 burn-cache hash — identical to every pre-picker config, so
      // existing videos are never needlessly re-burned.
      ...(font !== DEFAULT_SUPER_TEXT_FONT ? { font } : {}),
    };
    const parsed = superTextConfigSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }, [words, wordColors, stripColor, textColor, xPct, yPct, fontSizePct, font]);

  const moveTo = (clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    setXPct(Math.min(95, Math.max(5, ((clientX - rect.left) / rect.width) * 100)));
    setYPct(Math.min(95, Math.max(5, ((clientY - rect.top) / rect.height) * 100)));
  };

  const stageAspect = aspect ?? 9 / 16;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
       * max-h + flex-col with ONE scrollable middle region: the editor (stage +
       * text + colours + fonts + sizes) is taller than a laptop viewport, and
       * without this the footer — the ONLY way to apply — rendered below the
       * fold with no way to scroll to it (owner-reported 2026-09-02: "there is
       * no submit button"). Header and footer stay pinned; only the controls
       * scroll.
       *
       * onInteractOutside is prevented because an outside click otherwise
       * DISMISSES the dialog and silently discards every edit (same report:
       * "if we click outside it disappears"). Escape still cancels — that is a
       * deliberate gesture; a stray click on the page behind is not.
       */}
      <DialogContent
        className="flex max-h-[92dvh] max-w-md flex-col overflow-hidden"
        onInteractOutside={(e) => e.preventDefault()}
      >
        {/* Same shared builder the worker uses, so preview and burn load
            identical font bytes. Mounted here (not in the strip) so the ~19KB
            payload is injected once per editor, not per render. */}
        <SuperTextFontFaces />
        <DialogHeader className="flex-none">
          <DialogTitle>Super text</DialogTitle>
          <DialogDescription>
            Add a text strip that is burned into the video before it posts — to every channel you pick.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {/* Stage: the video (or a placeholder) with the draggable strip on top */}
          <div
            ref={stageRef}
            className="relative mx-auto w-full max-w-[280px] touch-none select-none overflow-hidden rounded-lg bg-zinc-900"
            style={{ aspectRatio: `${stageAspect}` }}
            onPointerDown={(e) => {
              draggingRef.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              moveTo(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (draggingRef.current) moveTo(e.clientX, e.clientY);
            }}
            onPointerUp={(e) => {
              draggingRef.current = false;
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              draggingRef.current = false;
            }}
          >
            {!skipInlineVideo ? (
              <video
                src={withPosterHint(videoUrl)}
                muted
                playsInline
                preload="metadata"
                className="pointer-events-none h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-zinc-500">
                <Film className="h-8 w-8" />
                <span className="px-3 text-center text-[10px]">
                  Large video — position the text using the frame below
                </span>
              </div>
            )}
            {previewConfig && stageWidth > 0 && (
              <SuperTextStrip config={previewConfig} stageWidth={stageWidth} />
            )}
          </div>
          <p className="text-center text-xs text-muted-foreground">
            Drag anywhere on the video to move the text.
          </p>

          {/* Text — the native emoji keyboard/picker inserts 😍 as plain characters */}
          <div className="space-y-1">
            <Label htmlFor="super-text-input">Text</Label>
            <Input
              id="super-text-input"
              value={text}
              onChange={(e) => setText(e.target.value.replace(/[\r\n]+/g, " ").slice(0, MAX_CHARS))}
              placeholder="Your text here… emoji welcome 😍✨"
            />
            <p className="text-right text-[10px] text-muted-foreground">
              {text.length}/{MAX_CHARS}
            </p>
          </div>

          {/* Per-word colours: tap a word, then a swatch */}
          {words.length > 0 && (
            <div className="space-y-2">
              <Label>Colour a word</Label>
              <div className="flex flex-wrap gap-1">
                {words.map((w, i) => (
                  <button
                    key={`${i}-${w}`}
                    type="button"
                    onClick={() => setSelectedWord(selectedWord === i ? null : i)}
                    className={`rounded border px-1.5 py-0.5 text-xs font-semibold ${
                      selectedWord === i ? "border-primary ring-1 ring-primary" : "border-transparent bg-muted"
                    }`}
                    style={wordColors[i] ? { color: wordColors[i] } : undefined}
                  >
                    {w}
                  </button>
                ))}
              </div>
              {selectedWord !== null && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="rounded border px-1.5 py-0.5 text-xs"
                    onClick={() => setWordColors((p) => ({ ...p, [selectedWord]: undefined }))}
                  >
                    Default
                  </button>
                  {WORD_COLOR_SWATCHES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Colour word ${c}`}
                      className="h-5 w-5 rounded-full border"
                      style={{ background: c }}
                      onClick={() => setWordColors((p) => ({ ...p, [selectedWord]: c }))}
                    />
                  ))}
                  <input
                    type="color"
                    aria-label="Custom word colour"
                    className="h-6 w-8 cursor-pointer bg-transparent"
                    value={wordColors[selectedWord] ?? textColor}
                    onChange={(e) => setWordColors((p) => ({ ...p, [selectedWord]: e.target.value }))}
                  />
                </div>
              )}
            </div>
          )}

          {/* Typeface. Each button previews its own face, so the choice is
              visible before it is made. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <div className="flex items-center gap-1">
              {SUPER_TEXT_FONT_KEYS.map((k) => (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={font === k ? "default" : "outline"}
                  onClick={() => setFont(k)}
                  style={{
                    fontFamily: SUPER_TEXT_FONTS[k].stack,
                    fontWeight: SUPER_TEXT_FONTS[k].weight,
                  }}
                >
                  {SUPER_TEXT_FONTS[k].label}
                </Button>
              ))}
            </div>
          </div>

          {/* Strip + default text colour, and size */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <label className="flex items-center gap-1.5">
              Strip
              <input
                type="color"
                aria-label="Strip colour"
                value={stripColor}
                onChange={(e) => setStripColor(e.target.value)}
                className="h-6 w-8 cursor-pointer bg-transparent"
              />
            </label>
            <label className="flex items-center gap-1.5">
              Text
              <input
                type="color"
                aria-label="Text colour"
                value={textColor}
                onChange={(e) => setTextColor(e.target.value)}
                className="h-6 w-8 cursor-pointer bg-transparent"
              />
            </label>
            <div className="flex items-center gap-1">
              {(Object.keys(FONT_SIZE_PRESETS) as Array<keyof typeof FONT_SIZE_PRESETS>).map((k) => (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={fontSizePct === FONT_SIZE_PRESETS[k] ? "default" : "outline"}
                  onClick={() => setFontSizePct(FONT_SIZE_PRESETS[k])}
                >
                  {k}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="flex-none gap-2 border-t pt-3 sm:gap-2">
          {initial && (
            <Button type="button" variant="destructive" onClick={() => onSave(null)}>
              Remove
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!previewConfig} onClick={() => previewConfig && onSave(previewConfig)}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
