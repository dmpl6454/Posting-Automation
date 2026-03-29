"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

export interface ActiveTask {
  id: string;
  type: "compose" | "generate" | "repurpose" | "publish" | "image";
  label: string;
  description?: string;
  href: string;
  /** Partial draft data to restore */
  draft?: {
    content?: string;
    channels?: string[];
    mediaUrls?: string[];
  };
  createdAt: number;
}

interface ActiveTaskContextValue {
  tasks: ActiveTask[];
  addTask: (task: ActiveTask) => void;
  updateTask: (id: string, updates: Partial<ActiveTask>) => void;
  removeTask: (id: string) => void;
  getTask: (id: string) => ActiveTask | undefined;
}

const ActiveTaskContext = createContext<ActiveTaskContextValue | null>(null);

const STORAGE_KEY = "pa-active-tasks";

function loadTasks(): ActiveTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const tasks = JSON.parse(raw) as ActiveTask[];
    // Expire tasks older than 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return tasks.filter((t) => t.createdAt > cutoff);
  } catch {
    return [];
  }
}

function saveTasks(tasks: ActiveTask[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {}
}

export function ActiveTaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<ActiveTask[]>([]);

  // Load from localStorage on mount
  useEffect(() => {
    setTasks(loadTasks());
  }, []);

  // Persist whenever tasks change
  useEffect(() => {
    if (tasks.length > 0 || localStorage.getItem(STORAGE_KEY)) {
      saveTasks(tasks);
    }
  }, [tasks]);

  const addTask = useCallback((task: ActiveTask) => {
    setTasks((prev) => {
      const filtered = prev.filter((t) => t.id !== task.id);
      return [task, ...filtered].slice(0, 10); // max 10 tasks
    });
  }, []);

  const updateTask = useCallback((id: string, updates: Partial<ActiveTask>) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...updates } : t))
    );
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const getTask = useCallback(
    (id: string) => tasks.find((t) => t.id === id),
    [tasks]
  );

  return (
    <ActiveTaskContext.Provider value={{ tasks, addTask, updateTask, removeTask, getTask }}>
      {children}
    </ActiveTaskContext.Provider>
  );
}

export function useActiveTask() {
  const ctx = useContext(ActiveTaskContext);
  if (!ctx) throw new Error("useActiveTask must be used within ActiveTaskProvider");
  return ctx;
}
