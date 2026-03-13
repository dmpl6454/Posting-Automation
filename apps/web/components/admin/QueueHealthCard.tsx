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
    <Card>
      <CardHeader>
        <CardTitle>Queue Health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {queues.length === 0 && (
          <p className="text-sm text-muted-foreground">No queues available</p>
        )}
        {queues.map((queue) => (
          <div
            key={queue.name}
            className="flex items-center justify-between rounded-md border px-3 py-2"
          >
            <span className="font-mono text-xs">{queue.name}</span>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-yellow-600">{queue.waiting} waiting</span>
              <span className="text-blue-600">{queue.active} active</span>
              <span className="text-red-600">{queue.failed} failed</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
