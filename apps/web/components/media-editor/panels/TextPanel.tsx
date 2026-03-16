"use client";

import { Canvas, IText } from "fabric";
import { Button } from "~/components/ui/button";

interface TextPanelProps {
  canvas: Canvas | null;
}

const TEXT_PRESETS = [
  { label: "Add a heading", fontSize: 48, fontWeight: "bold", fontFamily: "Arial" },
  { label: "Add a subheading", fontSize: 32, fontWeight: "600", fontFamily: "Arial" },
  { label: "Add body text", fontSize: 18, fontWeight: "normal", fontFamily: "Arial" },
  { label: "Add small text", fontSize: 14, fontWeight: "normal", fontFamily: "Arial" },
];

const FONT_COMBOS = [
  { heading: "Impact", body: "Arial", label: "Bold & Clean" },
  { heading: "Georgia", body: "Verdana", label: "Classic Serif" },
  { heading: "Trebuchet MS", body: "Lucida Sans", label: "Modern Sans" },
  { heading: "Courier New", body: "Georgia", label: "Typewriter" },
  { heading: "Palatino", body: "Book Antiqua", label: "Elegant" },
];

export function TextPanel({ canvas }: TextPanelProps) {
  const addText = (preset: (typeof TEXT_PRESETS)[0]) => {
    if (!canvas) return;
    const text = new IText(preset.label, {
      left: 100,
      top: 100,
      fontSize: preset.fontSize,
      fontWeight: preset.fontWeight,
      fontFamily: preset.fontFamily,
      fill: "#000000",
      editable: true,
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    canvas.renderAll();
  };

  const addFontCombo = (combo: (typeof FONT_COMBOS)[0]) => {
    if (!canvas) return;
    const heading = new IText("Heading", {
      left: 100, top: 80, fontSize: 42, fontWeight: "bold",
      fontFamily: combo.heading, fill: "#000000", editable: true,
    });
    const body = new IText("Body text goes here", {
      left: 100, top: 140, fontSize: 18, fontWeight: "normal",
      fontFamily: combo.body, fill: "#374151", editable: true,
    });
    canvas.add(heading, body);
    canvas.renderAll();
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Text</h3>
      <div className="space-y-2">
        {TEXT_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            variant="outline"
            className="w-full justify-start text-left"
            style={{ fontSize: Math.min(preset.fontSize * 0.5, 18), fontWeight: preset.fontWeight }}
            onClick={() => addText(preset)}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <h3 className="text-sm font-semibold">Font Combinations</h3>
      <div className="space-y-2">
        {FONT_COMBOS.map((combo) => (
          <Button
            key={combo.label}
            variant="outline"
            className="w-full flex-col items-start gap-0 py-2 text-left"
            onClick={() => addFontCombo(combo)}
          >
            <span style={{ fontFamily: combo.heading, fontWeight: "bold", fontSize: 14 }}>
              {combo.label}
            </span>
            <span style={{ fontFamily: combo.body, fontSize: 11 }} className="text-muted-foreground">
              {combo.heading} + {combo.body}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
