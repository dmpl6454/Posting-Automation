"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Repeat2,
  ImagePlus,
  Layers,
  PenLine,
  CalendarDays,
  Palette,
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
  /* Bumped by the header "Create Design" CTA — ComposeTab opens the MediaEditor
     on any increase. The design puts this button in the page header, so the
     header owns the click rather than duplicating it inside the compose column. */
  const [openDesignSignal, setOpenDesignSignal] = useState(0);

  /** Header "Create Design": land on Compose, then open the design editor. */
  const handleCreateDesign = () => {
    setShowCalendar(false);
    setActiveTab("compose");
    setOpenDesignSignal((n) => n + 1);
  };

  return (
    /* Outer padding comes from DashboardShell (p-4 sm:p-6 lg:p-8) — only the
       bottom breathing room is set here. Full width by design: no max-width
       cap, so the page fills the shell on wide screens. */
    <div className="w-full pb-6">
        {/* ── Page header — eyebrow, display title, actions (design restyle) ── */}
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="eyebrow">Content Studio</span>
            <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
              Create, schedule, publish.
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              Create, schedule, and manage all your social media content
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* One authoritative calendar TOGGLE, per the design's calToggle —
                its label and active fill both flip. Previously this only ever
                switched the calendar ON, so there was no way back from the
                header and a second toggle had to be duplicated further down. */}
            <Button
              variant="outline"
              aria-pressed={showCalendar}
              className={
                showCalendar
                  ? "h-9 gap-[7px] rounded-[9px] border-[hsl(var(--accent-border))] bg-gold/[0.12] px-3.5 text-[12.5px] font-semibold text-gold hover:bg-gold/20 hover:text-gold"
                  : "h-9 gap-[7px] rounded-[9px] border-border bg-surface2 px-3.5 text-[12.5px] font-medium hover:border-border2 hover:bg-hover"
              }
              onClick={() => setShowCalendar((v) => !v)}
            >
              <CalendarDays className="h-3.5 w-3.5 shrink-0" />
              {showCalendar ? "Hide Calendar" : "Calendar"}
            </Button>
            <Button
              className="pa-cta-gold h-9 gap-[7px] rounded-[9px] px-3.5 text-[12.5px] font-semibold"
              onClick={handleCreateDesign}
            >
              <Palette className="h-3.5 w-3.5 shrink-0" />
              Create Design
            </Button>
          </div>
        </div>

        {/* ── Calendar view. In the design the calendar REPLACES the studio
            (its `showCalendar` and `showPosts` are mutually exclusive) and sits
            directly under the header rather than below the tab content. ── */}
        {showCalendar && (
          <div className="mt-6">
            <CalendarTab />
          </div>
        )}

        {/* ── Unified Tabs (the design's `showPosts` branch).
            HIDDEN rather than unmounted while the calendar is open: ComposeTab
            is forceMount precisely so an in-flight multi-GB upload survives, and
            unmounting this subtree would abort it. ── */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className={showCalendar ? "hidden" : "mt-6"}
        >
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-[11px] border border-border bg-surface1 p-1 sm:grid-cols-4">
            {tabs.map(({ id, label, icon: Icon }) => (
              <TabsTrigger
                key={id}
                value={id}
                className="group w-full gap-[7px] rounded-lg py-2 text-[12.5px] font-medium text-muted-foreground data-[state=active]:bg-tile data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_0_0_1px_hsl(var(--border-2))]"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-data-[state=active]:text-gold" />
                <span>{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Layman helper — what the active tab does (audit clarity 2026-06-06) */}
          <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
            {activeTab === "compose" && "Write a post, attach media, pick channels, and schedule or publish."}
            {activeTab === "create" && "Let AI draft captions or generate an image for your post."}
            {activeTab === "repurpose" && "Paste a URL — AI turns it into captions and media you can post."}
            {activeTab === "bulk" && "Create or import many posts at once (CSV) and schedule them."}
          </p>

          {/* forceMount keeps ComposeTab ALIVE across tab switches so an
              in-flight multi-GB upload (and all compose state) survives —
              Radix unmounts inactive tabs by default, which killed uploads
              headless. data-[state=inactive]:hidden is REQUIRED with
              forceMount or this pane paints under every other tab.
              ONLY compose gets this — do not forceMount the other tabs. */}
          <TabsContent value="compose" forceMount className="mt-4 data-[state=inactive]:hidden">
            <ComposeTab
              isActive={activeTab === "compose"}
              initialContent={composeContent}
              initialImage={composeImage}
              initialImageMediaId={composeMediaId}
              initialMediaIds={composeMediaIds.length > 0 ? composeMediaIds : undefined}
              initialMediaUrls={composeMediaUrls.length > 0 ? composeMediaUrls : undefined}
              openDesignSignal={openDesignSignal}
              onPostCreated={() => setPostCreated((n) => n + 1)}
              externalMediaToAdd={pendingMedia}
              onExternalMediaConsumed={() => setPendingMedia(null)}
            />
          </TabsContent>

          <TabsContent value="create" className="mt-4">
            {/* ?subTab=image (from /dashboard/image-studio) opens the Image generator */}
            <Tabs defaultValue={searchParams.get("subTab") === "image" ? "image" : "content"} className="w-full">
              <TabsList className="grid h-auto w-full grid-cols-2 mb-4">
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

        {/* ── Recent posts. The design drops this list from Content Studio, but
            it is the only route to drafts / scheduled / failed / archived posts,
            so it stays — the duplicate "Recent Posts ⇄ Calendar" switch that
            used to sit here is gone now that the header toggle is authoritative. ── */}
        {!showCalendar && (
          <div className="mt-8">
            <PostsTab
              key={postCreated}
              onSwitchTab={(tab) => {
                if (tab === "calendar") setShowCalendar(true);
                else setActiveTab(tab);
              }}
            />
          </div>
        )}
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
