"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useActiveTask, type ActiveTask } from "~/lib/active-task";
import { Button } from "~/components/ui/button";
import {
  Sparkles,
  Repeat2,
  ImagePlus,
  Send,
  PenLine,
  X,
  ArrowRight,
} from "lucide-react";
import { cn } from "~/lib/utils";

const TYPE_CONFIG: Record<ActiveTask["type"], { icon: any; color: string; bg: string }> = {
  compose: { icon: PenLine, color: "text-purple-500", bg: "bg-purple-500/10 border-purple-500/20" },
  generate: { icon: Sparkles, color: "text-blue-500", bg: "bg-blue-500/10 border-blue-500/20" },
  repurpose: { icon: Repeat2, color: "text-cyan-500", bg: "bg-cyan-500/10 border-cyan-500/20" },
  publish: { icon: Send, color: "text-green-500", bg: "bg-green-500/10 border-green-500/20" },
  image: { icon: ImagePlus, color: "text-orange-500", bg: "bg-orange-500/10 border-orange-500/20" },
};

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function ActiveTaskBar() {
  const pathname = usePathname();
  const { tasks, removeTask } = useActiveTask();

  // Don't show if no tasks or if we're already on the task's page
  const visibleTasks = tasks.filter((t) => !pathname.startsWith(t.href.split("?")[0]!));

  if (visibleTasks.length === 0) return null;

  return (
    <div className="border-b border-border/40 bg-card/60 backdrop-blur-sm">
      <div className="flex items-center gap-2 overflow-x-auto px-4 py-1.5">
        {visibleTasks.map((task) => {
          const config = TYPE_CONFIG[task.type];
          const Icon = config.icon;

          return (
            <div
              key={task.id}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                config.bg
              )}
            >
              <Icon className={cn("h-3.5 w-3.5 shrink-0", config.color)} />
              <div className="min-w-0">
                <span className="font-medium">{task.label}</span>
                {task.description && (
                  <span className="ml-1.5 text-muted-foreground truncate max-w-[200px] inline-block align-bottom">
                    {task.description}
                  </span>
                )}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {timeAgo(task.createdAt)}
              </span>
              <Link href={task.href}>
                <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" title="Go back to task">
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </Link>
              <button
                onClick={() => removeTask(task.id)}
                className="text-muted-foreground hover:text-foreground shrink-0"
                title="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
