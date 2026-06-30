"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Repeat2,
  ImagePlus,
  Layers,
  PenLine,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { GenerateTab } from "~/components/content-agent/GenerateTab";
import { RepurposeTab } from "~/components/content-agent/RepurposeTab";
import { ImageTab } from "~/components/content-agent/ImageTab";
import { PostsTab } from "~/components/content-agent/PostsTab";
import { ComposeTab } from "~/components/content-agent/ComposeTab";
import { CalendarTab } from "~/components/content-agent/CalendarTab";
import { BulkTab } from "~/components/content-agent/BulkTab";
import { Button } from "~/components/ui/button";
import { parseCreatePostMediaIds, parseCsvList } from "~/lib/repurpose-create-post-params";

const tabs = [
  { id: "compose", label: "Compose", icon: PenLine },
  { id: "create", label: "AI Create", icon: Sparkles },
  { id: "repurpose", label: "Repurpose", icon: Repeat2 },
  { id: "bulk", label: "Bulk Create", icon: Layers },
];

function ContentStudioInner() {
  const searchParams = useSearchParams();
  const composeContent = searchParams.get("content") || undefined;
  const composeImage = searchParams.get("aiImage") || undefined;
  const composeMediaId = searchParams.get("aiMediaId") || undefined;
  // Carousel "Create Post" forwards ALL slide ids via ?aiMediaIds=a,b,c. Prefer
  // that multi-id list; fall back to the single ?aiMediaId for static/reel.
  const composeMediaIds = parseCreatePostMediaIds({
    aiMediaIds: searchParams.get("aiMediaIds"),
    aiMediaId: searchParams.get("aiMediaId"),
  });
  // Parallel slide preview URLs for the carousel deep link (same order as ids).
  const composeMediaUrls = parseCsvList(searchParams.get("aiImages"));

  // Accept ?tab= (canonical) and ?expanded= (legacy dashboard cards) — audit fix 2026-06-06
  const initialTab = searchParams.get("tab") || searchParams.get("expanded") || "compose";
  const [activeTab, setActiveTab] = useState(composeContent || composeImage ? "compose" : initialTab);
  const [postCreated, setPostCreated] = useState(0);
  // ?view=calendar deep-links (legacy /dashboard/calendar) open the calendar view
  const [showCalendar, setShowCalendar] = useState(searchParams.get("view") === "calendar");
  const [pendingMedia, setPendingMedia] = useState<{ dataUrl: string } | null>(null);

  return (
    <div className="h-[calc(100dvh-4rem)] overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4">
          {/* Header */}
          <div>
            <h1 className="text-xl font-bold tracking-tight">Content Studio</h1>
            <p className="text-xs text-muted-foreground">
              Create, schedule, and manage all your social media content
            </p>
          </div>

          {/* ── Unified Tabs ── */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4">
              {tabs.map(({ id, label, icon: Icon }) => (
                <TabsTrigger key={id} value={id} className="gap-1.5 text-xs">
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            {/* Layman helper — what the active tab does (audit clarity 2026-06-06) */}
            <p className="mt-2 text-xs text-muted-foreground">
              {activeTab === "compose" && "Write a post, attach media, pick channels, and schedule or publish."}
              {activeTab === "create" && "Let AI draft captions or generate an image for your post."}
              {activeTab === "repurpose" && "Paste a URL — AI turns it into captions and media you can post."}
              {activeTab === "bulk" && "Create or import many posts at once (CSV) and schedule them."}
            </p>

            <TabsContent value="compose" className="mt-4">
              <ComposeTab
                initialContent={composeContent}
                initialImage={composeImage}
                initialImageMediaId={composeMediaId}
                initialMediaIds={composeMediaIds.length > 0 ? composeMediaIds : undefined}
                initialMediaUrls={composeMediaUrls.length > 0 ? composeMediaUrls : undefined}
                onPostCreated={() => setPostCreated((n) => n + 1)}
                externalMediaToAdd={pendingMedia}
                onExternalMediaConsumed={() => setPendingMedia(null)}
              />
            </TabsContent>

            <TabsContent value="create" className="mt-4">
              {/* ?subTab=image (from /dashboard/image-studio) opens the Image generator */}
              <Tabs defaultValue={searchParams.get("subTab") === "image" ? "image" : "content"} className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-4">
                  <TabsTrigger value="content" className="gap-1.5 text-xs">
                    <Sparkles className="h-3.5 w-3.5" />
                    Content
                  </TabsTrigger>
                  <TabsTrigger value="image" className="gap-1.5 text-xs">
                    <ImagePlus className="h-3.5 w-3.5" />
                    Image
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="content">
                  <GenerateTab />
                </TabsContent>
                <TabsContent value="image">
                  <ImageTab onImageGenerated={(dataUrl) => setPendingMedia({ dataUrl })} />
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="repurpose" className="mt-4">
              <RepurposeTab />
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
                else setActiveTab(tab);
              }}
            />
          ) : (
            <CalendarTab />
          )}
      </div>
    </div>
  );
}

export default function ContentStudioPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[calc(100dvh-4rem)] items-center justify-center">
          Loading...
        </div>
      }
    >
      <ContentStudioInner />
    </Suspense>
  );
}
