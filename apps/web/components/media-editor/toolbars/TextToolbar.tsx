"use client";

import { useState, useEffect } from "react";
import type { Canvas } from "fabric";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight,
} from "lucide-react";

interface TextToolbarProps {
  canvas: Canvas | null;
  object: any;
}

const FONTS = [
  "Arial", "Georgia", "Times New Roman", "Courier New", "Verdana",
  "Impact", "Trebuchet MS", "Palatino", "Lucida Sans", "Comic Sans MS",
];

export function TextToolbar({ canvas, object }: TextToolbarProps) {
  const [fontSize, setFontSize] = useState(object?.fontSize || 24);
  const [fontFamily, setFontFamily] = useState(object?.fontFamily || "Arial");
  const [fillColor, setFillColor] = useState(object?.fill || "#000000");

  useEffect(() => {
    if (!object) return;
    setFontSize(object.fontSize || 24);
    setFontFamily(object.fontFamily || "Arial");
    setFillColor(typeof object.fill === "string" ? object.fill : "#000000");
  }, [object]);

  const update = (prop: string, value: any) => {
    if (!canvas || !object) return;
    object.set(prop, value);
    canvas.renderAll();
  };

  const toggle = (prop: string) => {
    if (!object) return;
    const current = object[prop];
    const newVal = prop === "fontWeight" ? (current === "bold" ? "normal" : "bold") :
                   prop === "fontStyle" ? (current === "italic" ? "normal" : "italic") :
                   prop === "underline" ? !current : current;
    update(prop, newVal);
  };

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={fontFamily}
        onChange={(e) => {
          setFontFamily(e.target.value);
          update("fontFamily", e.target.value);
        }}
        className="h-7 rounded border bg-background px-1.5 text-xs"
      >
        {FONTS.map((f) => (
          <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
        ))}
      </select>

      <Input
        type="number"
        value={fontSize}
        onChange={(e) => {
          const val = Number(e.target.value);
          setFontSize(val);
          update("fontSize", val);
        }}
        className="h-7 w-14 text-xs"
        min={8}
        max={200}
      />

      <div className="mx-1 h-5 w-px bg-border" />

      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggle("fontWeight")}
        data-active={object?.fontWeight === "bold"}>
        <Bold className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggle("fontStyle")}
        data-active={object?.fontStyle === "italic"}>
        <Italic className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggle("underline")}
        data-active={object?.underline}>
        <Underline className="h-3.5 w-3.5" />
      </Button>

      <div className="mx-1 h-5 w-px bg-border" />

      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => update("textAlign", "left")}>
        <AlignLeft className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => update("textAlign", "center")}>
        <AlignCenter className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => update("textAlign", "right")}>
        <AlignRight className="h-3.5 w-3.5" />
      </Button>

      <div className="mx-1 h-5 w-px bg-border" />

      <input
        type="color"
        value={fillColor}
        onChange={(e) => {
          setFillColor(e.target.value);
          update("fill", e.target.value);
        }}
        className="h-7 w-7 cursor-pointer rounded border"
      />
    </div>
  );
}
