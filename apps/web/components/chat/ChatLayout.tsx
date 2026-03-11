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
    router.push(`/dashboard/agents/${threadId}`, { scroll: false });
  };

  const handleNewChat = () => {
    setActiveThreadId(null);
    router.push("/dashboard/agents", { scroll: false });
  };

  const handleThreadCreated = (threadId: string) => {
    setActiveThreadId(threadId);
    router.push(`/dashboard/agents/${threadId}`, { scroll: false });
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden rounded-xl border bg-background shadow-sm">
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
