"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Repeat2,
  ImagePlus,
  Layers,
  MessageSquare,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { ChatLayout } from "~/components/chat/ChatLayout";
import { GenerateTab } from "~/components/content-agent/GenerateTab";
import { RepurposeTab } from "~/components/content-agent/RepurposeTab";
import { ImageTab } from "~/components/content-agent/ImageTab";
import { PostsTab } from "~/components/content-agent/PostsTab";
import { ComposeTab } from "~/components/content-agent/ComposeTab";
import { CalendarTab } from "~/components/content-agent/CalendarTab";
import { BulkTab } from "~/components/content-agent/BulkTab";
import { cn } from "~/lib/utils";

type ExpandedSection = "generate" | "repurpose" | "image" | "bulk" | "chat" | null;

const aiTools = [
  { id: "generate" as const, label: "AI Generate", icon: Sparkles, color: "text-purple-500" },
  { id: "repurpose" as const, label: "Repurpose", icon: Repeat2, color: "text-blue-500" },
  { id: "image" as const, label: "AI Image", icon: ImagePlus, color: "text-green-500" },
  { id: "bulk" as const, label: "Bulk Create", icon: Layers, color: "text-orange-500" },
];

function ContentStudioInner() {
  const searchParams = useSearchParams();
  const composeContent = searchParams.get("content") || undefined;
  const composeImage = searchParams.get("aiImage") || undefined;
  const composeMediaId = searchParams.get("aiMediaId") || undefined;

  const [expanded, setExpanded] = useState<ExpandedSection>(null);
  const [postCreated, setPostCreated] = useState(0);
  const [showCalendar, setShowCalendar] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<{ dataUrl: string } | null>(null);

  const toggle = (section: ExpandedSection) =>
    setExpanded((prev) => (prev === section ? null : section));

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* ── Main content (scrollable) ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-4">
          {/* Header */}
          <div>
            <h1 className="text-xl font-bold tracking-tight">Content Studio</h1>
            <p className="text-xs text-muted-foreground">
              Create, schedule, and manage all your social media content
            </p>
          </div>

          {/* ── Compose ── */}
          <ComposeTab
            initialContent={composeContent}
            initialImage={composeImage}
            initialImageMediaId={composeMediaId}
            onPostCreated={() => setPostCreated((n) => n + 1)}
            externalMediaToAdd={pendingMedia}
            onExternalMediaConsumed={() => setPendingMedia(null)}
          />

          {/* ── AI Tools (expandable cards) ── */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {aiTools.map(({ id, label, icon: Icon, color }) => (
              <Button
                key={id}
                variant={expanded === id ? "default" : "outline"}
                className="h-auto flex-col gap-1 py-3"
                onClick={() => toggle(id)}
              >
                <Icon className={cn("h-5 w-5", expanded === id ? "text-white" : color)} />
                <span className="text-xs">{label}</span>
              </Button>
            ))}
          </div>

          {/* Expanded AI tool panel */}
          {expanded && expanded !== "chat" && (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">
                  {aiTools.find((t) => t.id === expanded)?.label}
                </h3>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  onClick={() => setExpanded(null)}
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
              </div>
              {expanded === "generate" && <GenerateTab />}
              {expanded === "repurpose" && <RepurposeTab />}
              {expanded === "image" && <ImageTab onImageGenerated={(dataUrl) => setPendingMedia({ dataUrl })} />}
              {expanded === "bulk" && <BulkTab />}
            </Card>
          )}

          {/* ── Posts & Calendar toggle ── */}
          <div className="flex items-center gap-2">
            <Button
              variant={!showCalendar ? "default" : "outline"}
              size="sm"
              onClick={() => setShowCalendar(false)}
            >
              Recent Posts
            </Button>
            <Button
              variant={showCalendar ? "default" : "outline"}
              size="sm"
              onClick={() => setShowCalendar(true)}
            >
              Calendar
            </Button>
          </div>

          {!showCalendar ? (
            <PostsTab
              key={postCreated}
              onSwitchTab={(tab) => {
                if (tab === "calendar") setShowCalendar(true);
              }}
            />
          ) : (
            <CalendarTab />
          )}
        </div>
      </div>

      {/* ── AI Chat sidebar (collapsible) ── */}
      <div
        className={cn(
          "flex flex-col border-l bg-background transition-all duration-200",
          expanded === "chat" ? "w-[380px]" : "w-10"
        )}
      >
        <button
          onClick={() => toggle("chat")}
          className="flex h-10 w-full items-center justify-center border-b hover:bg-muted"
          title="AI Chat"
        >
          <MessageSquare className="h-4 w-4" />
        </button>
        {expanded === "chat" && (
          <div className="flex-1 overflow-hidden">
            <ChatLayout />
          </div>
        )}
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
