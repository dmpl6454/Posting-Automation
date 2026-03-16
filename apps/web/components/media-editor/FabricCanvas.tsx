"use client";

import { useRef } from "react";

interface FabricCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  zoom: number;
  canvasWidth: number;
  canvasHeight: number;
}

export function FabricCanvas({ canvasRef, zoom, canvasWidth, canvasHeight }: FabricCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className="relative flex flex-1 items-center justify-center overflow-auto bg-zinc-100 dark:bg-zinc-900"
      style={{ minHeight: 400 }}
    >
      <div
        className="relative shadow-lg"
        style={{
          width: canvasWidth * zoom,
          height: canvasHeight * zoom,
          backgroundImage:
            "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)",
          backgroundSize: "20px 20px",
          backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
        }}
      >
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
