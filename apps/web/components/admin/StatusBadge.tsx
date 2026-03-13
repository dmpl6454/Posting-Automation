import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

const statusColorMap: Record<string, string> = {
  // Post statuses
  DRAFT: "bg-gray-100 text-gray-700 border-gray-200",
  SCHEDULED: "bg-blue-100 text-blue-700 border-blue-200",
  QUEUED: "bg-yellow-100 text-yellow-700 border-yellow-200",
  PUBLISHING: "bg-orange-100 text-orange-700 border-orange-200",
  PUBLISHED: "bg-green-100 text-green-700 border-green-200",
  FAILED: "bg-red-100 text-red-700 border-red-200",

  // Token / expiry statuses
  valid: "bg-green-100 text-green-700 border-green-200",
  expiring: "bg-yellow-100 text-yellow-700 border-yellow-200",
  expired: "bg-red-100 text-red-700 border-red-200",

  // Plan tiers
  FREE: "bg-gray-100 text-gray-700 border-gray-200",
  STARTER: "bg-blue-100 text-blue-700 border-blue-200",
  PROFESSIONAL: "bg-purple-100 text-purple-700 border-purple-200",
  ENTERPRISE: "bg-amber-100 text-amber-700 border-amber-200",
};

const defaultColor = "bg-gray-100 text-gray-700 border-gray-200";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const colorClasses = statusColorMap[status] ?? defaultColor;

  return (
    <Badge
      variant="outline"
      className={cn(colorClasses, className)}
    >
      {status}
    </Badge>
  );
}
