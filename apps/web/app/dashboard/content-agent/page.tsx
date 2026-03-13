"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Bot, Sparkles, Repeat2, ImagePlus } from "lucide-react";
import { ChatLayout } from "~/components/chat/ChatLayout";
import { GenerateTab } from "~/components/content-agent/GenerateTab";
import { RepurposeTab } from "~/components/content-agent/RepurposeTab";
import { ImageTab } from "~/components/content-agent/ImageTab";

function ContentAgentInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "chat";
  const [activeTab, setActiveTab] = useState(initialTab);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    router.replace(`/dashboard/content-agent?tab=${tab}`, { scroll: false });
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
      {/* Header with tabs */}
      <div className="flex-none border-b bg-background px-4 pt-2">
        <div className="flex items-center justify-between pb-2">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Content Agent</h1>
            <p className="text-xs text-muted-foreground">
              Your AI-powered content creation hub
            </p>
          </div>
        </div>
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="h-9 w-full justify-start rounded-none border-b-0 bg-transparent p-0">
            <TabsTrigger
              value="chat"
              className="gap-1.5 rounded-none border-b-2 border-transparent px-4 pb-2 pt-1 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              <Bot className="h-3.5 w-3.5" />
              Chat
            </TabsTrigger>
            <TabsTrigger
              value="generate"
              className="gap-1.5 rounded-none border-b-2 border-transparent px-4 pb-2 pt-1 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Generate
            </TabsTrigger>
            <TabsTrigger
              value="repurpose"
              className="gap-1.5 rounded-none border-b-2 border-transparent px-4 pb-2 pt-1 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              <Repeat2 className="h-3.5 w-3.5" />
              Repurpose
            </TabsTrigger>
            <TabsTrigger
              value="image"
              className="gap-1.5 rounded-none border-b-2 border-transparent px-4 pb-2 pt-1 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              Image
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "chat" && (
          <div className="h-full">
            <ChatLayout />
          </div>
        )}
        {activeTab === "generate" && (
          <div className="h-full overflow-y-auto p-6">
            <GenerateTab />
          </div>
        )}
        {activeTab === "repurpose" && (
          <div className="h-full overflow-y-auto p-6">
            <RepurposeTab />
          </div>
        )}
        {activeTab === "image" && (
          <div className="h-full overflow-y-auto p-6">
            <ImageTab />
          </div>
        )}
      </div>
    </div>
  );
}

export default function ContentAgentPage() {
  return (
    <Suspense fallback={<div className="flex h-[calc(100vh-4rem)] items-center justify-center">Loading...</div>}>
      <ContentAgentInner />
    </Suspense>
  );
}
