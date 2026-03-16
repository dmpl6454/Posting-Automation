"use client";

import { Canvas, Rect, Circle, Triangle, Line, Polygon } from "fabric";
import { Button } from "~/components/ui/button";

interface ElementsPanelProps {
  canvas: Canvas | null;
}

const SHAPES = [
  {
    name: "Rectangle",
    emoji: "▬",
    create: () =>
      new Rect({
        left: 100, top: 100, width: 200, height: 150,
        fill: "#4F46E5", stroke: "#3730A3", strokeWidth: 2, rx: 8, ry: 8,
      }),
  },
  {
    name: "Circle",
    emoji: "●",
    create: () =>
      new Circle({
        left: 100, top: 100, radius: 80,
        fill: "#EF4444", stroke: "#DC2626", strokeWidth: 2,
      }),
  },
  {
    name: "Triangle",
    emoji: "▲",
    create: () =>
      new Triangle({
        left: 100, top: 100, width: 180, height: 160,
        fill: "#10B981", stroke: "#059669", strokeWidth: 2,
      }),
  },
  {
    name: "Line",
    emoji: "━",
    create: () =>
      new Line([50, 100, 300, 100], {
        stroke: "#000000", strokeWidth: 3,
      }),
  },
  {
    name: "Star",
    emoji: "★",
    create: () => {
      const points = [];
      const outerRadius = 80;
      const innerRadius = 40;
      for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = (Math.PI / 5) * i - Math.PI / 2;
        points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
      }
      return new Polygon(points, {
        left: 100, top: 100, fill: "#F59E0B", stroke: "#D97706", strokeWidth: 2,
      });
    },
  },
  {
    name: "Arrow",
    emoji: "➤",
    create: () => {
      const points = [
        { x: 0, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 0 },
        { x: 120, y: 30 }, { x: 80, y: 60 }, { x: 80, y: 40 }, { x: 0, y: 40 },
      ];
      return new Polygon(points, {
        left: 100, top: 100, fill: "#6366F1", stroke: "#4F46E5", strokeWidth: 1,
      });
    },
  },
];

export function ElementsPanel({ canvas }: ElementsPanelProps) {
  const addShape = (createFn: () => any) => {
    if (!canvas) return;
    const obj = createFn();
    canvas.add(obj);
    canvas.setActiveObject(obj);
    canvas.renderAll();
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Shapes</h3>
      <div className="grid grid-cols-3 gap-2">
        {SHAPES.map((shape) => (
          <Button
            key={shape.name}
            variant="outline"
            size="sm"
            className="h-16 flex-col gap-1 text-[10px]"
            onClick={() => addShape(shape.create)}
          >
            <span className="text-lg">{shape.emoji}</span>
            {shape.name}
          </Button>
        ))}
      </div>
    </div>
  );
}
