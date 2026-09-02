"use client";

import { type ReactNode } from "react";
import { Search } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

export interface Column<T> {
  header: string;
  accessorKey?: keyof T & string;
  cell?: (row: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T extends { id: string }> {
  columns: Column<T>[];
  data: T[];
  searchPlaceholder?: string;
  onSearch?: (query: string) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoading?: boolean;
}

export function DataTable<T extends { id: string }>({
  columns,
  data,
  searchPlaceholder = "Search...",
  onSearch,
  hasMore,
  onLoadMore,
  isLoading,
}: DataTableProps<T>) {
  return (
    /* Design geometry: a 38px search field, then one r14 card holding the
       table. Header row sits on the tile fill at 11px/600 uppercase-weight,
       body rows are 12.5px on 1px border-border separators. */
    <div className="space-y-3.5">
      {onSearch && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            onChange={(e) => onSearch(e.target.value)}
            className="h-[38px] rounded-[8px] border-border2 bg-background pl-9 text-[12.5px]"
          />
        </div>
      )}

      <div className="overflow-hidden rounded-[14px] border border-border bg-card">
        <div className="max-w-full overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-border hover:bg-transparent">
                {columns.map((col) => (
                  <TableHead
                    key={col.header}
                    className={cn(
                      // Design: uppercase, letter-spaced column labels.
                      "h-auto whitespace-nowrap bg-tile px-5 py-3.5 text-[11px] font-medium uppercase leading-none tracking-[0.07em] text-muted-foreground",
                      col.className
                    )}
                  >
                    {col.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && data.length === 0 ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`} className="border-b border-border">
                    {columns.map((col) => (
                      <TableCell key={col.header} className="px-5 py-3.5">
                        <Skeleton className="h-4 w-full rounded-[6px]" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : data.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columns.length}
                    className="h-24 text-center text-[12.5px] text-muted-foreground"
                  >
                    No results found.
                  </TableCell>
                </TableRow>
              ) : (
                data.map((row) => (
                  <TableRow
                    key={row.id}
                    className="border-b border-border last:border-b-0 hover:bg-hover"
                  >
                    {columns.map((col) => (
                      <TableCell
                        key={col.header}
                        className={cn(
                          "px-5 py-3.5 text-[12.5px] leading-[1.4]",
                          col.className
                        )}
                      >
                        {col.cell
                          ? col.cell(row)
                          : col.accessorKey
                            ? String(row[col.accessorKey] ?? "")
                            : null}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={isLoading}
            className="h-9 rounded-[8px] border-border2 px-[15px] text-[12px] font-medium hover:bg-hover"
          >
            {isLoading ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
