"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Filter,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// Action categories for color-coding
const ACTION_COLORS: Record<string, string> = {
  created: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  connected: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  invited: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  deleted: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  removed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  disconnected: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  updated: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  changed: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  refreshed: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  published: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-400",
  scheduled: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  login: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-400",
};

function getActionColor(action: string): string {
  const actionPart = action.split(".").pop() || "";
  return ACTION_COLORS[actionPart] || "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-400";
}

function formatAction(action: string): string {
  return action
    .split(".")
    .map((part: string) => part.replace(/_/g, " "))
    .join(" / ");
}

function formatDate(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n: string) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// All possible action values for the filter dropdown
const ALL_ACTIONS = [
  { value: "post.created", label: "Post Created" },
  { value: "post.updated", label: "Post Updated" },
  { value: "post.deleted", label: "Post Deleted" },
  { value: "post.published", label: "Post Published" },
  { value: "post.scheduled", label: "Post Scheduled" },
  { value: "channel.connected", label: "Channel Connected" },
  { value: "channel.disconnected", label: "Channel Disconnected" },
  { value: "channel.refreshed", label: "Channel Refreshed" },
  { value: "member.invited", label: "Member Invited" },
  { value: "member.removed", label: "Member Removed" },
  { value: "member.role_changed", label: "Member Role Changed" },
  { value: "apikey.created", label: "API Key Created" },
  { value: "apikey.deleted", label: "API Key Deleted" },
  { value: "webhook.created", label: "Webhook Created" },
  { value: "webhook.updated", label: "Webhook Updated" },
  { value: "webhook.deleted", label: "Webhook Deleted" },
  { value: "billing.plan_changed", label: "Plan Changed" },
  { value: "billing.subscription_cancelled", label: "Subscription Cancelled" },
  { value: "org.settings_updated", label: "Org Settings Updated" },
  { value: "auth.login", label: "User Login" },
];

const ALL_ENTITY_TYPES = [
  { value: "Post", label: "Post" },
  { value: "Channel", label: "Channel" },
  { value: "OrganizationMember", label: "Team Member" },
  { value: "ApiKey", label: "API Key" },
  { value: "Webhook", label: "Webhook" },
  { value: "Organization", label: "Organization" },
];

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<string>("");
  const [entityType, setEntityType] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const { data, isLoading } = trpc.audit.list.useQuery({
    page,
    limit: 25,
    action: action || undefined,
    entityType: entityType || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
  });

  const resetFilters = () => {
    setAction("");
    setEntityType("");
    setStartDate("");
    setEndDate("");
    setPage(1);
  };

  const hasActiveFilters = action || entityType || startDate || endDate;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-muted-foreground">
          Track all actions and changes across your organization
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Filters</CardTitle>
              {hasActiveFilters && (
                <Badge variant="secondary" className="text-xs">
                  Active
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={resetFilters}>
                  Clear all
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowFilters(!showFilters)}
              >
                {showFilters ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        {showFilters && (
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {/* Action filter */}
              <div className="space-y-1.5">
                <Label className="text-xs">Action</Label>
                <Select
                  value={action}
                  onValueChange={(val: string) => {
                    setAction(val === "__all__" ? "" : val);
                    setPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All actions" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All actions</SelectItem>
                    {ALL_ACTIONS.map((a: any) => (
                      <SelectItem key={a.value} value={a.value}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Entity type filter */}
              <div className="space-y-1.5">
                <Label className="text-xs">Entity Type</Label>
                <Select
                  value={entityType}
                  onValueChange={(val: string) => {
                    setEntityType(val === "__all__" ? "" : val);
                    setPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All types</SelectItem>
                    {ALL_ENTITY_TYPES.map((et: any) => (
                      <SelectItem key={et.value} value={et.value}>
                        {et.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Start date */}
              <div className="space-y-1.5">
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e: any) => {
                    setStartDate(e.target.value);
                    setPage(1);
                  }}
                />
              </div>

              {/* End date */}
              <div className="space-y-1.5">
                <Label className="text-xs">To</Label>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e: any) => {
                    setEndDate(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Audit Log Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Activity</CardTitle>
              <CardDescription>
                {data
                  ? `${data.total} event${data.total !== 1 ? "s" : ""} found`
                  : "Loading..."}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-6">
              {[1, 2, 3, 4, 5].map((i: number) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !data?.logs.length ? (
            <div className="flex flex-col items-center py-16">
              <FileText className="h-10 w-10 text-muted-foreground/30" />
              <p className="mt-3 text-sm text-muted-foreground">
                No audit log entries found
              </p>
              {hasActiveFilters && (
                <Button
                  variant="link"
                  size="sm"
                  className="mt-1"
                  onClick={resetFilters}
                >
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">Timestamp</TableHead>
                  <TableHead className="w-[180px]">User</TableHead>
                  <TableHead className="w-[180px]">Action</TableHead>
                  <TableHead className="w-[120px]">Entity</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.logs.map((log: any) => (
                  <TableRow
                    key={log.id}
                    className="cursor-pointer"
                    onClick={() =>
                      setExpandedRow(
                        expandedRow === log.id ? null : log.id
                      )
                    }
                  >
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(log.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-6 w-6">
                          <AvatarImage src={log.user?.image || undefined} />
                          <AvatarFallback className="text-[10px]">
                            {getInitials(log.user?.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="truncate text-sm">
                          {log.user?.name || log.user?.email || "System"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`text-[11px] font-medium ${getActionColor(log.action)}`}
                      >
                        {formatAction(log.action)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">
                        {log.entityType}
                      </span>
                      {log.entityId && (
                        <span className="ml-1 font-mono text-[10px] text-muted-foreground/70">
                          {log.entityId.slice(0, 8)}...
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {log.metadata ? (
                        <div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={(e: any) => {
                              e.stopPropagation();
                              setExpandedRow(
                                expandedRow === log.id ? null : log.id
                              );
                            }}
                          >
                            {expandedRow === log.id ? (
                              <>
                                <ChevronUp className="mr-1 h-3 w-3" />
                                Hide
                              </>
                            ) : (
                              <>
                                <ChevronDown className="mr-1 h-3 w-3" />
                                Show
                              </>
                            )}
                          </Button>
                          {expandedRow === log.id && (
                            <pre className="mt-2 max-w-xs overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
                              {JSON.stringify(log.metadata, null, 2)}
                            </pre>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">
                          --
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {data.page} of {data.totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p: number) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setPage((p: number) => Math.min(data.totalPages, p + 1))
              }
              disabled={page >= data.totalPages}
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
