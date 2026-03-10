"use client";

import { useState, useRef, useCallback } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Calendar,
  Upload,
  Download,
  CheckCircle,
  Loader2,
  AlertCircle,
  FileSpreadsheet,
} from "lucide-react";
import { toast } from "~/hooks/use-toast";

// ---------------------------------------------------------------------------
// Bulk Schedule Tab
// ---------------------------------------------------------------------------
function BulkScheduleTab() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scheduledAt, setScheduledAt] = useState("");
  const { data, isLoading } = trpc.post.list.useQuery({ status: "DRAFT" as any, limit: 100 });
  const utils = trpc.useUtils();
  const bulkSchedule = trpc.bulk.bulkSchedule.useMutation({
    onSuccess: (result) => {
      toast({ title: "Scheduled", description: `${result.scheduled} post(s) scheduled successfully.` });
      setSelectedIds(new Set());
      setScheduledAt("");
      utils.post.list.invalidate();
    },
    onError: (err) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (!data?.posts) return;
    if (selectedIds.size === data.posts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(data.posts.map((p: any) => p.id)));
    }
  };

  const handleSchedule = () => {
    if (selectedIds.size === 0 || !scheduledAt) return;
    bulkSchedule.mutate({
      items: Array.from(selectedIds).map((postId) => ({ postId, scheduledAt: new Date(scheduledAt).toISOString() })),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          Bulk Schedule Posts
        </CardTitle>
        <CardDescription>Select draft posts and schedule them all at once</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-4">
          <div className="flex-1">
            <Label htmlFor="bulk-schedule-date">Schedule Date & Time</Label>
            <Input
              id="bulk-schedule-date"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="mt-1"
            />
          </div>
          <Button
            onClick={handleSchedule}
            disabled={selectedIds.size === 0 || !scheduledAt || bulkSchedule.isPending}
          >
            {bulkSchedule.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Calendar className="mr-2 h-4 w-4" />
            )}
            Schedule Selected ({selectedIds.size})
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : !data?.posts?.length ? (
          <div className="flex flex-col items-center py-12 text-muted-foreground">
            <AlertCircle className="h-10 w-10 mb-2" />
            <p>No draft posts available to schedule</p>
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === data.posts.length && data.posts.length > 0}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </TableHead>
                  <TableHead>Content</TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.posts.map((post: any) => (
                  <TableRow key={post.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(post.id)}
                        onChange={() => toggleSelect(post.id)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate font-medium">
                      {post.content.slice(0, 80)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {post.targets?.map((t: any) => (
                          <Badge key={t.id} variant="outline" className="text-xs">
                            {t.channel?.platform}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(post.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CSV Import Tab
// ---------------------------------------------------------------------------
interface ParsedRow {
  content: string;
  scheduledAt?: string;
}

function CSVImportTab() {
  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [globalScheduledAt, setGlobalScheduledAt] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: channels } = trpc.channel.list.useQuery();
  const utils = trpc.useUtils();

  const csvImport = trpc.bulk.csvImport.useMutation({
    onSuccess: (result) => {
      toast({
        title: "Import Complete",
        description: `${result.imported} post(s) imported.${result.errors.length > 0 ? ` ${result.errors.length} error(s).` : ""}`,
      });
      setParsedRows([]);
      setFile(null);
      setParseErrors(result.errors);
      utils.post.list.invalidate();
    },
    onError: (err) => {
      toast({ title: "Import Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      if (lines.length < 2) {
        setParseErrors(["CSV must have a header row and at least one data row"]);
        setParsedRows([]);
        return;
      }

      const headers = parseCSVRow(lines[0] as string).map((h) => h.trim().toLowerCase());
      const contentIdx = headers.indexOf("content");
      if (contentIdx === -1) {
        setParseErrors(['CSV must have a "content" column']);
        setParsedRows([]);
        return;
      }
      const scheduledAtIdx = headers.indexOf("scheduledat");

      const rows: ParsedRow[] = [];
      const errors: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVRow(lines[i] as string);
        const content = cols[contentIdx]?.trim() || "";
        if (!content) {
          errors.push(`Row ${i + 1}: empty content, will be skipped`);
          continue;
        }
        const scheduled = scheduledAtIdx !== -1 ? cols[scheduledAtIdx]?.trim() : undefined;
        rows.push({ content, scheduledAt: scheduled || undefined });
      }
      setParsedRows(rows);
      setParseErrors(errors);
    };
    reader.readAsText(selected);
  }, []);

  const handleImport = () => {
    if (parsedRows.length === 0 || selectedChannels.length === 0 || !file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const csvData = event.target?.result as string;
      csvImport.mutate({
        csvData,
        channelIds: selectedChannels,
        scheduledAt: globalScheduledAt ? new Date(globalScheduledAt).toISOString() : undefined,
      });
    };
    reader.readAsText(file);
  };

  const toggleChannel = (id: string) => {
    setSelectedChannels((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          CSV Import
        </CardTitle>
        <CardDescription>
          Upload a CSV file with columns: content (required), scheduledAt (optional)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* File upload area */}
        <div
          className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 cursor-pointer hover:border-primary/50 transition-colors"
          onClick={() => fileInputRef.current?.click()}
        >
          <FileSpreadsheet className="h-10 w-10 text-muted-foreground mb-2" />
          <p className="text-sm font-medium">
            {file ? file.name : "Click to upload CSV file"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Accepts .csv files
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Parse errors */}
        {parseErrors.length > 0 && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3">
            <p className="text-sm font-medium text-yellow-800 mb-1">Warnings:</p>
            <ul className="text-xs text-yellow-700 space-y-1">
              {parseErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Preview table */}
        {parsedRows.length > 0 && (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Content</TableHead>
                    <TableHead>Scheduled At</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.slice(0, 20).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      <TableCell className="max-w-[400px] truncate">{row.content}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.scheduledAt || "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {parsedRows.length > 20 && (
              <p className="text-sm text-muted-foreground">
                Showing first 20 of {parsedRows.length} rows
              </p>
            )}
          </>
        )}

        {/* Channel selector */}
        {parsedRows.length > 0 && (
          <div className="space-y-2">
            <Label>Target Channels</Label>
            <div className="flex flex-wrap gap-2">
              {channels?.map((ch: any) => (
                <Button
                  key={ch.id}
                  variant={selectedChannels.includes(ch.id) ? "default" : "outline"}
                  size="sm"
                  onClick={() => toggleChannel(ch.id)}
                >
                  {ch.platform} - {ch.name}
                </Button>
              ))}
            </div>
            {(!channels || channels.length === 0) && (
              <p className="text-sm text-muted-foreground">No channels connected</p>
            )}
          </div>
        )}

        {/* Optional global scheduled date */}
        {parsedRows.length > 0 && (
          <div>
            <Label htmlFor="import-schedule-date">
              Default Schedule (for rows without scheduledAt)
            </Label>
            <Input
              id="import-schedule-date"
              type="datetime-local"
              value={globalScheduledAt}
              onChange={(e) => setGlobalScheduledAt(e.target.value)}
              className="mt-1 max-w-xs"
            />
          </div>
        )}

        {/* Import button */}
        {parsedRows.length > 0 && (
          <Button
            onClick={handleImport}
            disabled={selectedChannels.length === 0 || csvImport.isPending}
            className="w-full"
          >
            {csvImport.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Import {parsedRows.length} Posts
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CSV Export Tab
// ---------------------------------------------------------------------------
function CSVExportTab() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  const csvExport = trpc.bulk.csvExport.useQuery(
    {
      status: statusFilter || undefined,
      startDate: startDate ? new Date(startDate).toISOString() : undefined,
      endDate: endDate ? new Date(endDate).toISOString() : undefined,
    },
    { enabled: false }
  );

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const result = await csvExport.refetch();
      if (result.data?.csv) {
        const blob = new Blob([result.data.csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `posts-export-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toast({
          title: "Export Complete",
          description: `${result.data.count} post(s) exported.`,
        });
      }
    } catch (err: any) {
      toast({ title: "Export Failed", description: err.message, variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          CSV Export
        </CardTitle>
        <CardDescription>Export your posts as a CSV file</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label>Status Filter</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="DRAFT">Draft</SelectItem>
                <SelectItem value="SCHEDULED">Scheduled</SelectItem>
                <SelectItem value="PUBLISHED">Published</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="export-start-date">Start Date</Label>
            <Input
              id="export-start-date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="export-end-date">End Date</Label>
            <Input
              id="export-end-date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1"
            />
          </div>
        </div>

        <Button onClick={handleExport} disabled={isExporting} className="w-full">
          {isExporting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          Export Posts to CSV
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function BulkOperationsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Bulk Operations</h1>
        <p className="text-muted-foreground">
          Schedule, import, and export posts in bulk
        </p>
      </div>

      <Tabs defaultValue="schedule" className="space-y-4">
        <TabsList>
          <TabsTrigger value="schedule">
            <Calendar className="mr-2 h-4 w-4" />
            Bulk Schedule
          </TabsTrigger>
          <TabsTrigger value="import">
            <Upload className="mr-2 h-4 w-4" />
            CSV Import
          </TabsTrigger>
          <TabsTrigger value="export">
            <Download className="mr-2 h-4 w-4" />
            CSV Export
          </TabsTrigger>
        </TabsList>

        <TabsContent value="schedule">
          <BulkScheduleTab />
        </TabsContent>

        <TabsContent value="import">
          <CSVImportTab />
        </TabsContent>

        <TabsContent value="export">
          <CSVExportTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV Parsing Helper (client-side)
// ---------------------------------------------------------------------------
function parseCSVRow(row: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const char = row[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < row.length && row[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}
