"use client";

import { cn } from "~/lib/utils";
import {
  LayoutTemplate,
  Shapes,
  Type,
  Upload,
  Pencil,
  Sparkles,
} from "lucide-react";

export type SidebarPanel = "templates" | "elements" | "text" | "uploads" | "draw" | "ai" | null;

const PANELS: { id: SidebarPanel; icon: any; label: string }[] = [
  { id: "templates", icon: LayoutTemplate, label: "Templates" },
  { id: "elements", icon: Shapes, label: "Elements" },
  { id: "text", icon: Type, label: "Text" },
  { id: "uploads", icon: Upload, label: "Uploads" },
  { id: "draw", icon: Pencil, label: "Draw" },
  { id: "ai", icon: Sparkles, label: "AI" },
];

interface EditorSidebarProps {
  activePanel: SidebarPanel;
  onPanelChange: (panel: SidebarPanel) => void;
  children?: React.ReactNode;
}

export function EditorSidebar({ activePanel, onPanelChange, children }: EditorSidebarProps) {
  return (
    <div className="flex h-full">
      {/* Icon Strip — narrower on mobile to leave room for the canvas */}
      <div className="flex w-12 shrink-0 flex-col gap-1 overflow-y-auto border-r bg-muted/30 p-1 sm:w-14 sm:p-1.5">
        {PANELS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => onPanelChange(activePanel === id ? null : id)}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-lg p-1.5 text-[10px] transition-colors sm:p-2",
              activePanel === id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
            title={label ?? undefined}
          >
            <Icon className="h-5 w-5" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Expandable Panel.
          Mobile: overlay drawer anchored next to the rail (does not shrink the
          canvas to nothing). lg+: in-flow side column as before. */}
      {activePanel && (
        <div
          className={cn(
            "overflow-y-auto border-r bg-background p-3 shadow-xl",
            "absolute inset-y-0 left-12 z-20 w-[min(16rem,calc(100%-3rem))] sm:left-14",
            "lg:static lg:left-auto lg:z-auto lg:w-64 lg:shadow-none"
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
