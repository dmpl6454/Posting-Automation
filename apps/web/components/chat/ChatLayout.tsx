"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Menu } from "lucide-react";
import { AgentSidebar } from "./AgentSidebar";
import { ChatView } from "./ChatView";

interface ChatLayoutProps {
  initialThreadId?: string | null;
}

export function ChatLayout({ initialThreadId = null }: ChatLayoutProps) {
  const router = useRouter();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    initialThreadId
  );
  // Mobile drawer state for the thread sidebar (closed by default on phones;
  // the sidebar is always visible on lg+ via responsive classes).
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const closeOnMobile = () => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      setSidebarOpen(false);
    }
  };

  const handleSelectThread = (threadId: string) => {
    setActiveThreadId(threadId);
    closeOnMobile();
    router.push(`/dashboard/content-agent/${threadId}`, { scroll: false });
  };

  const handleNewChat = () => {
    setActiveThreadId(null);
    closeOnMobile();
    router.push("/dashboard/content-agent", { scroll: false });
  };

  const handleThreadCreated = (threadId: string) => {
    setActiveThreadId(threadId);
    router.push(`/dashboard/content-agent/${threadId}`, { scroll: false });
  };

  return (
    <div className="relative flex h-full overflow-hidden rounded-xl border bg-background shadow-sm">
      {/* Mobile drawer backdrop */}
      {sidebarOpen && (
        <div
          className="absolute inset-0 z-30 bg-black/40 lg:hidden"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <AgentSidebar
        activeThreadId={activeThreadId}
        onSelectThread={handleSelectThread}
        onNewChat={handleNewChat}
        open={sidebarOpen}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile-only toggle to open the thread drawer */}
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="flex items-center gap-2 border-b px-4 py-2 text-sm text-muted-foreground hover:bg-muted/50 lg:hidden"
        >
          <Menu className="h-4 w-4" />
          Conversations
        </button>
        <div className="min-h-0 flex-1">
          <ChatView
            threadId={activeThreadId}
            onThreadCreated={handleThreadCreated}
          />
        </div>
      </div>
    </div>
  );
}
