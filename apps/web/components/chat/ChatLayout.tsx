"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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

  const handleSelectThread = (threadId: string) => {
    setActiveThreadId(threadId);
    router.push(`/dashboard/content-agent/${threadId}`, { scroll: false });
  };

  const handleNewChat = () => {
    setActiveThreadId(null);
    router.push("/dashboard/content-agent", { scroll: false });
  };

  const handleThreadCreated = (threadId: string) => {
    setActiveThreadId(threadId);
    router.push(`/dashboard/content-agent/${threadId}`, { scroll: false });
  };

  return (
    <div className="flex h-full overflow-hidden rounded-xl border bg-background shadow-sm">
      <AgentSidebar
        activeThreadId={activeThreadId}
        onSelectThread={handleSelectThread}
        onNewChat={handleNewChat}
      />
      <div className="flex-1">
        <ChatView
          threadId={activeThreadId}
          onThreadCreated={handleThreadCreated}
        />
      </div>
    </div>
  );
}
