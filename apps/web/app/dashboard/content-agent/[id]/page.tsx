"use client";

import { useParams } from "next/navigation";
import { ChatLayout } from "~/components/chat/ChatLayout";

export default function ContentAgentChatPage() {
  const params = useParams();
  const threadId = params.id as string;

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
      <div className="h-full">
        <ChatLayout initialThreadId={threadId} />
      </div>
    </div>
  );
}
