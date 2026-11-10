import { Skeleton } from "~/components/ui/skeleton";

/**
 * Route-level loading screen for every dashboard page (2026-11-10).
 *
 * Next.js shows this inside the dashboard layout (sidebar and header stay put)
 * the moment a navigation starts, while the next page's code and data load.
 * Without it a click on a slow phone or network shows nothing until the whole
 * page is ready, which reads as "the app froze".
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
