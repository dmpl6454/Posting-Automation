"use client";

import { useState, useCallback, useRef } from "react";
import { trpc } from "~/lib/trpc/client";

interface ChatMessageData {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: any;
  attachments?: any[];
  createdAt?: string | Date;
}

// Action types that should be auto-executed without user clicking a button
const AUTO_EXECUTE_ACTIONS = new Set(["publish_now"]);

export function useChatStream(threadId: string | null) {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const executeActionRef = useRef<(action: any) => Promise<any>>();

  const utils = trpc.useUtils();

  const sendMessageMutation = trpc.chat.sendMessage.useMutation();
  const executeActionMutation = trpc.chat.executeAction.useMutation();

  // Load messages into state when thread data arrives
  const loadMessages = useCallback((msgs: ChatMessageData[]) => {
    setMessages(msgs);
  }, []);

  const sendMessage = useCallback(
    async (content: string, attachmentMediaIds?: string[]) => {
      if (!threadId || !content.trim()) return;

      // Optimistically add user message
      const tempUserMsg: ChatMessageData = {
        id: `temp-${Date.now()}`,
        role: "user",
        content: content.trim(),
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempUserMsg]);

      // Save user message to DB
      try {
        const savedMsg = await sendMessageMutation.mutateAsync({
          threadId,
          content: content.trim(),
          attachmentMediaIds,
        });

        // Replace temp message with saved one
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempUserMsg.id
              ? {
                  id: savedMsg.id,
                  role: savedMsg.role as "user" | "assistant" | "system",
                  content: savedMsg.content,
                  metadata: savedMsg.metadata,
                  attachments: savedMsg.attachments as any,
                  createdAt: savedMsg.createdAt,
                }
              : m
          )
        );
      } catch (error) {
        // Remove temp message on error
        setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
        return;
      }

      // Start streaming AI response
      setIsStreaming(true);
      setStreamingContent("");

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("Failed to stream response");
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const lines = text.split("\n");

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);

              if (event.type === "chunk") {
                accumulated += event.content;
                setStreamingContent(accumulated);
              } else if (event.type === "done") {
                // Add the final assistant message
                const assistantMsg: ChatMessageData = {
                  id: `assistant-${Date.now()}`,
                  role: "assistant",
                  content: event.displayText || accumulated,
                  metadata: event.action ? { action: event.action } : undefined,
                  createdAt: new Date().toISOString(),
                };
                setMessages((prev) => [...prev, assistantMsg]);
                setStreamingContent("");

                // Auto-execute certain actions (like publish_now) without
                // requiring the user to click a button
                if (event.action && AUTO_EXECUTE_ACTIONS.has(event.action.type)) {
                  executeActionRef.current?.(event.action);
                }
              } else if (event.type === "error") {
                const errorMsg: ChatMessageData = {
                  id: `error-${Date.now()}`,
                  role: "system",
                  content: `Error: ${event.message}`,
                  createdAt: new Date().toISOString(),
                };
                setMessages((prev) => [...prev, errorMsg]);
                setStreamingContent("");
              }
            } catch {
              // Ignore malformed JSON
            }
          }
        }
      } catch (error: any) {
        if (error.name !== "AbortError") {
          const errorMsg: ChatMessageData = {
            id: `error-${Date.now()}`,
            role: "system",
            content: "Failed to get AI response. Please try again.",
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
        setStreamingContent("");
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [threadId, sendMessageMutation]
  );

  const executeAction = useCallback(
    async (action: any) => {
      if (!threadId) return;

      try {
        const result = await executeActionMutation.mutateAsync({
          threadId,
          actionType: action.type,
          payload: action.payload,
        });

        // Refresh thread data
        utils.chat.getThread.invalidate({ id: threadId });
        utils.chat.listThreads.invalidate();
        utils.agent.list.invalidate();

        return result;
      } catch (error: any) {
        const errorMsg: ChatMessageData = {
          id: `error-${Date.now()}`,
          role: "system",
          content: `Action failed: ${error.message}`,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    },
    [threadId, executeActionMutation, utils]
  );

  // Keep ref in sync so the streaming callback can auto-execute actions
  executeActionRef.current = executeAction;

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    messages,
    isStreaming,
    streamingContent,
    sendMessage,
    executeAction,
    loadMessages,
    stopStreaming,
    isExecuting: executeActionMutation.isPending,
  };
}
