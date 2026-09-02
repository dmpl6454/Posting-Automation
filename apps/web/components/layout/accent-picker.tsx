"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "~/components/ui/card";
import {
  ACCENT_OPTIONS,
  DEFAULT_ACCENT,
  applyAccent,
  readStoredAccent,
  storeAccent,
} from "~/lib/accent";

export function AccentPicker() {
  // Start on the default so server and first client render agree; the stored
  // value is adopted in the effect below (reading localStorage during render
  // would be a hydration mismatch).
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setAccent(readStoredAccent());
    setReady(true);
  }, []);

  const choose = (hex: string) => {
    setAccent(hex);
    applyAccent(hex);
    storeAccent(hex);
  };

  const currentName =
    ACCENT_OPTIONS.find((a) => a.hex.toLowerCase() === accent.toLowerCase())
      ?.name ?? "Yellow";

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="text-[14.5px] font-semibold leading-[1.2]">
          Accent Color
        </h2>
        <p className="mt-[5px] text-[12px] leading-[1.5] text-muted-foreground">
          Changes buttons and highlights across the app.
          {ready ? ` Currently ${currentName}.` : ""} The rest of the design —
          backgrounds, cards, text, borders, and charts — stays as is.
        </p>
        <div className="mt-[18px] flex flex-wrap gap-4">
          {ACCENT_OPTIONS.map((option) => {
            const selected =
              ready && option.hex.toLowerCase() === accent.toLowerCase();
            return (
              <div key={option.hex} className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => choose(option.hex)}
                  aria-pressed={selected}
                  aria-label={`${option.name} accent`}
                  className="flex h-11 w-11 items-center justify-center rounded-[10px] border-2 transition-colors"
                  style={{
                    background: option.hex,
                    borderColor: selected ? "hsl(var(--foreground))" : "transparent",
                  }}
                >
                  {selected && (
                    <span className="h-2 w-2 rounded-full bg-[#1a1712]" />
                  )}
                </button>
                <span className="text-[10.5px] font-medium leading-none text-muted-foreground">
                  {option.name}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
