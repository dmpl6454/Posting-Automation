"use client";

import { useParams } from "next/navigation";
import { ChatLayout } from "~/components/chat/ChatLayout";

export default function AgentChatPage() {
  const params = useParams();
  const threadId = params.id as string;

  return <ChatLayout initialThreadId={threadId} />;
}
