"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Repeat2,
  ImagePlus,
  Layers,
  MessageSquare,
  PenLine,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { ChatLayout } from "~/components/chat/ChatLayout";
import { CommandPrompt } from "~/components/content-agent/CommandPrompt";
import { GenerateTab } from "~/components/content-agent/GenerateTab";
import { RepurposeTab } from "~/components/content-agent/RepurposeTab";
import { ImageTab } from "~/components/content-agent/ImageTab";
import { PostsTab } from "~/components/content-agent/PostsTab";
import { ComposeTab } from "~/components/content-agent/ComposeTab";
import { CalendarTab } from "~/components/content-agent/CalendarTab";
import { BulkTab } from "~/components/content-agent/BulkTab";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const tabs = [
  { id: "compose", label: "Compose", icon: PenLine },
  { id: "generate", label: "AI Generate", icon: Sparkles },
  { id: "repurpose", label: "Repurpose", icon: Repeat2 },
  { id: "image", label: "AI Image", icon: ImagePlus },
  { id: "bulk", label: "Bulk Create", icon: Layers },
];

function SuperAgentInner() {
  const searchParams = useSearchParams();
  const composeContent = searchParams.get("content") || undefined;
  const composeImage = searchParams.get("aiImage") || undefined;
  const composeMediaId = searchParams.get("aiMediaId") || undefined;

  const defaultTab = composeContent || composeImage ? "compose" : "compose";
  const [activeTab, setActiveTab] = useState(defaultTab);
  const [postCreated, setPostCreated] = useState(0);
  const [showCalendar, setShowCalendar] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<{ dataUrl: string } | null>(null);

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* ── Main content (scrollable) ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-4">
          {/* Header */}
          <div>
            <h1 className="text-xl font-bold tracking-tight">Super Agent</h1>
            <p className="text-xs text-muted-foreground">
              Create, design, and generate content with AI — all in one place
            </p>
          </div>

          {/* ── AI Command Prompt ── */}
          <CommandPrompt />

          {/* ── Unified Tabs ── */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-5">
              {tabs.map(({ id, label, icon: Icon }) => (
                <TabsTrigger key={id} value={id} className="gap-1.5 text-xs">
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="compose" className="mt-4">
              <ComposeTab
                initialContent={composeContent}
                initialImage={composeImage}
                initialImageMediaId={composeMediaId}
                onPostCreated={() => setPostCreated((n) => n + 1)}
                externalMediaToAdd={pendingMedia}
                onExternalMediaConsumed={() => setPendingMedia(null)}
              />
            </TabsContent>

            <TabsContent value="generate" className="mt-4">
              <GenerateTab />
            </TabsContent>

            <TabsContent value="repurpose" className="mt-4">
              <RepurposeTab />
            </TabsContent>

            <TabsContent value="image" className="mt-4">
              <ImageTab onImageGenerated={(dataUrl) => setPendingMedia({ dataUrl })} />
            </TabsContent>

            <TabsContent value="bulk" className="mt-4">
              <BulkTab />
            </TabsContent>
          </Tabs>

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
          chatOpen ? "w-[380px]" : "w-10"
        )}
      >
        <button
          onClick={() => setChatOpen((o) => !o)}
          className="flex h-10 w-full items-center justify-center border-b hover:bg-muted"
          title="AI Chat"
        >
          <MessageSquare className="h-4 w-4" />
        </button>
        {chatOpen && (
          <div className="flex-1 overflow-hidden">
            <ChatLayout />
          </div>
        )}
      </div>
    </div>
  );
}

export default function SuperAgentPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
          Loading...
        </div>
      }
    >
      <SuperAgentInner />
    </Suspense>
  );
}
