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
      {/* Icon Strip */}
      <div className="flex w-14 flex-col gap-1 border-r bg-muted/30 p-1.5">
        {PANELS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => onPanelChange(activePanel === id ? null : id)}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-lg p-2 text-[10px] transition-colors",
              activePanel === id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
            title={label}
          >
            <Icon className="h-5 w-5" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Expandable Panel */}
      {activePanel && (
        <div className="w-64 overflow-y-auto border-r bg-background p-3">
          {children}
        </div>
      )}
    </div>
  );
}
