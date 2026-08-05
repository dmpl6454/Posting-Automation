"use client";

import { useState } from "react";
import Link from "next/link";
import { Users, Radio } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
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
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">{row.slug}</p>
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
    { header: "Plan", cell: (row) => <Badge variant="outline">{row.plan}</Badge> },
    {
      header: "",
      cell: (row) => (
        <Button asChild variant="outline" size="sm">
          <Link href={`/admin/teams/${row.id}`}>Manage</Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Teams</h1>
        <p className="text-sm text-muted-foreground">
          A team is a workspace with more than one member. Every member shares all
          of that workspace&apos;s channels, insights and posts.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={onlyTeams ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyTeams((v) => !v)}
        >
          {onlyTeams ? "Teams only" : "All workspaces"}
        </Button>
        <p className="text-xs text-muted-foreground">
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
