"use client";

import { useState } from "react";
import Link from "next/link";
import { Users, Radio } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { Button } from "~/components/ui/button";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { useDebounce } from "~/hooks/use-debounce";

type TeamRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  createdAt: Date;
  _count: { members: number; channels: number; posts: number };
};

export default function AdminTeamsPage() {
  const [search, setSearch] = useState("");
  const [onlyTeams, setOnlyTeams] = useState(true);
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage } =
    trpc.admin.teams.list.useInfiniteQuery(
      { search: debouncedSearch || undefined, onlyTeams, limit: 50 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const items = (data?.pages.flatMap((p) => p.items) ?? []) as TeamRow[];

  const columns: Column<TeamRow>[] = [
    {
      header: "Workspace",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold leading-[1.3]">{row.name}</p>
          <p className="mt-[3px] truncate text-[12px] leading-[1.3] text-muted-foreground">
            {row.slug}
          </p>
        </div>
      ),
    },
    {
      header: "Members",
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          {row._count.members}
        </span>
      ),
    },
    {
      header: "Shared channels",
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <Radio className="h-3.5 w-3.5 text-muted-foreground" />
          {row._count.channels}
        </span>
      ),
    },
    { header: "Posts", cell: (row) => row._count.posts },
    // One source of pill styling across the admin console.
    { header: "Plan", cell: (row) => <StatusBadge status={row.plan} /> },
    {
      header: "",
      className: "text-right",
      cell: (row) => (
        <Button
          asChild
          variant="outline"
          className="h-9 rounded-[8px] border-border2 px-[15px] text-[12.5px] font-medium hover:bg-hover"
        >
          <Link href={`/admin/teams/${row.id}`}>Manage</Link>
        </Button>
      ),
    },
  ];

  return (
    /* Design stacks sections on 20px. */
    <div className="w-full space-y-5">
      {/* Admin-console page header: a plain bold title + sub. This module does
          NOT use the eyebrow/display headline the user-facing pages use — the
          page name is already in the top bar and the design shows one bold
          heading here. */}
      <div className="min-w-0">
        <h1 className="text-[29px] font-bold leading-[1.1] tracking-[-0.01em]">Teams</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          A team is a workspace with more than one member. Every member shares all
          of that workspace&apos;s channels, insights and posts.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* Gold pill when the filter is on, quiet outline when it is off —
            the design's active/inactive toggle pair. */}
        <Button
          onClick={() => setOnlyTeams((v) => !v)}
          className={
            onlyTeams
              ? "pa-cta-gold h-9 shrink-0 rounded-[8px] px-[15px] text-[12px] font-semibold"
              : "h-9 shrink-0 rounded-[8px] border border-border2 bg-transparent px-[15px] text-[12px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
          }
        >
          {onlyTeams ? "Teams only" : "All workspaces"}
        </Button>
        <p className="text-[11.5px] leading-[1.5] text-muted-foreground">
          {onlyTeams
            ? "Showing workspaces with 2+ members. Switch to “All workspaces” to turn a single-member workspace into a team."
            : "Showing every workspace. Open one and add a member to make it a team."}
        </p>
      </div>

      <DataTable
        columns={columns}
        data={items}
        isLoading={isLoading}
        searchPlaceholder="Search by workspace or member email…"
        onSearch={setSearch}
        hasMore={hasNextPage}
        onLoadMore={() => {
          if (!isFetchingNextPage) fetchNextPage();
        }}
      />
    </div>
  );
}
