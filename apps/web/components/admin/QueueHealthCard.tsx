import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

interface QueueHealthCardProps {
  queues: QueueStats[];
}

export function QueueHealthCard({ queues }: QueueHealthCardProps) {
  return (
    /* Design (admin console): 12px radius, 16px padding, 13px/600 heading. */
    <Card className="rounded-[12px]">
      <CardHeader className="p-4 pb-0">
        <CardTitle className="text-[13px] font-semibold">Queue Health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-4">
        {queues.length === 0 && (
          <p className="text-sm text-muted-foreground">No queues available</p>
        )}
        {/* Design: queue name on its own line, counts beneath it. `completed`
            was already carried in the data but never rendered — the design
            shows it as "done", so a healthy queue reads as busy, not idle. */}
        {queues.map((queue) => (
          <div
            key={queue.name}
            className="rounded-[10px] border border-border px-3.5 py-2.5"
          >
            <span className="font-mono text-[12px] font-medium leading-none">
              {queue.name.toLowerCase().replace(/_/g, "-")}
            </span>
            {/* Literal hex: the Tailwind config flattens amber/blue/emerald/red
                onto the palette's status triplets, so these four counts all
                rendered the same colour as each other. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11.5px] leading-none">
              <span className="text-[#e0b84a]">{queue.waiting} waiting</span>
              <span className="text-[#5b9bd5]">{queue.active} active</span>
              <span className="text-[#5cb85c]">{queue.completed} done</span>
              <span className={queue.failed > 0 ? "text-[#d9695f]" : "text-[#5cb85c]"}>
                {queue.failed} failed
              </span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
