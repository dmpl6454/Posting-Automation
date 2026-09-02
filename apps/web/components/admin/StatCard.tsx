import { type LucideIcon } from "lucide-react";
import { Card, CardContent } from "~/components/ui/card";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  description?: string;
}

export function StatCard({ title, value, icon: Icon, description }: StatCardProps) {
  return (
    /* Design (admin console): a plain muted 15px icon on top, then the number at
       22px/700, then the label — no tinted tile, no side-by-side split. The admin
       cards are 12px radius and 16px padding, tighter than the 14px/24px cards on
       the user-facing side, so five fit across without crowding. */
    <Card className="rounded-[12px]">
      <CardContent className="p-4">
        <Icon className="h-[15px] w-[15px] text-muted-foreground" />
        <p className="mt-2.5 text-[22px] font-bold leading-none tracking-[-0.01em]">
          {value}
        </p>
        <p className="mt-[5px] text-[11px] font-medium leading-[1.3] text-muted-foreground">
          {title}
        </p>
        {description && (
          <p className="mt-[3px] text-[10px] leading-[1.3] text-faint">
            {description}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
