"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "~/components/ui/button";
import { Sparkles, Repeat2, ImagePlus, Layers, MessageSquare, PenSquare, CalendarDays, X } from "lucide-react";
import { ChatLayout } from "~/components/chat/ChatLayout";
import { GenerateTab } from "~/components/content-agent/GenerateTab";
import { RepurposeTab } from "~/components/content-agent/RepurposeTab";
import { ImageTab } from "~/components/content-agent/ImageTab";
import { PostsTab } from "~/components/content-agent/PostsTab";
import { ComposeTab } from "~/components/content-agent/ComposeTab";
import { CalendarTab } from "~/components/content-agent/CalendarTab";
import { BulkTab } from "~/components/content-agent/BulkTab";
import { cn } from "~/lib/utils";

type Tool = "generate" | "repurpose" | "image" | "bulk" | null;
type RightPanel = "chat" | "posts" | "calendar";

const tools = [
  { id: "generate" as Tool, label: "Generate", icon: Sparkles },
  { id: "repurpose" as Tool, label: "Repurpose", icon: Repeat2 },
  { id: "image" as Tool, label: "Image", icon: ImagePlus },
  { id: "bulk" as Tool, label: "Bulk", icon: Layers },
];

const rightPanels = [
  { id: "chat" as RightPanel, label: "Chat", icon: MessageSquare },
  { id: "posts" as RightPanel, label: "Posts", icon: PenSquare },
  { id: "calendar" as RightPanel, label: "Calendar", icon: CalendarDays },
];

function ContentStudioInner() {
  const searchParams = useSearchParams();
  const composeContent = searchParams.get("content") || undefined;
  const composeImage = searchParams.get("aiImage") || undefined;
  const composeMediaId = searchParams.get("aiMediaId") || undefined;

  const [activeTool, setActiveTool] = useState<Tool>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>("chat");
  const [postCreated, setPostCreated] = useState(0);

  const toggleTool = (tool: Tool) => {
    setActiveTool((prev) => (prev === tool ? null : tool));
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-none border-b bg-background px-4 py-3">
        <h1 className="text-xl font-bold tracking-tight">Content Studio</h1>
        <p className="text-xs text-muted-foreground">
          Create, schedule, and manage all your social media content
        </p>
      </div>

      {/* Main 2-column layout */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left column: Compose + Tool panels ── */}
        <div className="flex w-[58%] flex-col border-r overflow-hidden">

          {/* Compose area */}
          <div className="flex-1 overflow-y-auto p-4">
            <ComposeTab
              initialContent={composeContent}
              initialImage={composeImage}
              initialImageMediaId={composeMediaId}
              onPostCreated={() => {
                setPostCreated((n) => n + 1);
                setRightPanel("posts");
              }}
            />
          </div>

          {/* Tool toggle buttons */}
          <div className="flex-none border-t bg-muted/30 px-4 py-2 flex items-center gap-2">
            <span className="text-xs text-muted-foreground mr-1">AI Tools:</span>
            {tools.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                size="sm"
                variant={activeTool === id ? "default" : "outline"}
                className="h-7 gap-1.5 text-xs"
                onClick={() => toggleTool(id)}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {activeTool === id && <X className="h-3 w-3 ml-0.5" />}
              </Button>
            ))}
          </div>

          {/* Active tool panel */}
          {activeTool && (
            <div className="flex-none border-t max-h-[45%] overflow-y-auto bg-background">
              <div className="p-4">
                {activeTool === "generate" && <GenerateTab />}
                {activeTool === "repurpose" && <RepurposeTab />}
                {activeTool === "image" && <ImageTab />}
                {activeTool === "bulk" && <BulkTab />}
              </div>
            </div>
          )}
        </div>

        {/* ── Right column: Chat / Posts / Calendar ── */}
        <div className="flex w-[42%] flex-col overflow-hidden">

          {/* Right panel switcher */}
          <div className="flex-none border-b bg-muted/20 flex">
            {rightPanels.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setRightPanel(id)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2 text-xs font-medium transition-colors",
                  rightPanel === id
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Right panel content */}
          <div className="flex-1 overflow-hidden">
            {rightPanel === "chat" && (
              <div className="h-full">
                <ChatLayout />
              </div>
            )}
            {rightPanel === "posts" && (
              <div className="h-full overflow-y-auto p-4">
                <PostsTab
                  key={postCreated}
                  onSwitchTab={(tab) => {
                    if (tab === "calendar") setRightPanel("calendar");
                  }}
                />
              </div>
            )}
            {rightPanel === "calendar" && (
              <div className="h-full overflow-y-auto p-4">
                <CalendarTab />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ContentStudioPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
          Loading...
        </div>
      }
    >
      <ContentStudioInner />
    </Suspense>
  );
}
