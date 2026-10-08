"use client";

import Link from "next/link";
import { FileArchive } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { Skeleton } from "~/components/ui/skeleton";
import { CAMPAIGN_REPORT_LINKS_SHOWN, campaignReportHref } from "~/lib/campaign-report-link";

/**
 * "Reports on your own posts, by campaign" (2026-10-08). The Campaigns page
 * monitors OTHER brands; the campaign-wise report of the workspace's own posts
 * (views, likes, comments, reach — grouped by the campaign name set in Compose)
 * lives in Insights → Reports. This card links straight to it, one link per
 * campaign name, opened on that campaign.
 */
export function OwnCampaignReports() {
  const { data: labels, isLoading } = trpc.analytics.campaignLabels.useQuery();
  const shown = (labels ?? []).slice(0, CAMPAIGN_REPORT_LINKS_SHOWN);
  const more = (labels?.length ?? 0) - shown.length;

  return (
    <div className="rounded-[12px] border border-border bg-card px-4 py-3.5" data-testid="own-campaign-reports">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <FileArchive className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold leading-[1.4]">Reports on your own posts, by campaign</p>
            <p className="mt-0.5 text-[12px] leading-[1.6] text-muted-foreground">
              Views, likes, comments and reach for the posts you published with a campaign name (set in Compose).
              Opens Insights → Reports on that campaign, with <b className="text-foreground">Export CSV</b> and{" "}
              <b className="text-foreground">Download per campaign</b> (a ZIP with one CSV per campaign). Covers up to the
              last 30 days.
            </p>
          </div>
        </div>
        <Link
          href={campaignReportHref()}
          className="shrink-0 rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium hover:bg-hover"
          data-testid="own-campaign-reports-all"
        >
          All campaigns
        </Link>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 pl-[27px]">
        {isLoading ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-6 w-24 rounded-full" />)
        ) : shown.length === 0 ? (
          <p className="text-[11.5px] text-faint" data-testid="own-campaign-reports-empty">
            None of your posts has a campaign name yet. Add one in Compose (the Campaign field) and its report appears here.
          </p>
        ) : (
          <>
            {shown.map((label) => (
              <Link
                key={label}
                href={campaignReportHref(label)}
                className="max-w-[16rem] truncate rounded-full border border-border bg-surface1 px-2.5 py-1 text-[11.5px] hover:border-border2 hover:text-foreground"
                title={`Open the report for “${label}”`}
                data-testid="own-campaign-report-link"
              >
                {label}
              </Link>
            ))}
            {more > 0 && (
              <Link href={campaignReportHref()} className="px-1 text-[11.5px] text-muted-foreground underline hover:text-foreground">
                +{more} more
              </Link>
            )}
          </>
        )}
      </div>
    </div>
  );
}
