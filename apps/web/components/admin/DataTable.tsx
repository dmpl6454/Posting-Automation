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
    <div className="space-y-4">
      {onSearch && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            onChange={(e) => onSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col.header} className={col.className}>
                  {col.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && data.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  {columns.map((col) => (
                    <TableCell key={col.header}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  No results found.
                </TableCell>
              </TableRow>
            ) : (
              data.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((col) => (
                    <TableCell key={col.header} className={col.className}>
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

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={isLoading}
          >
            {isLoading ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
