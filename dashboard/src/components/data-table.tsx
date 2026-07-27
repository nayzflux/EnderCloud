"use client";

import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface Column<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  /** Providing a sort value makes the column header clickable. */
  readonly sortValue?: (row: T) => string | number;
  readonly align?: "left" | "right";
  readonly className?: string;
  /** Hidden below the `md` breakpoint to keep narrow viewports readable. */
  readonly hideOnMobile?: boolean;
}

interface DataTableProps<T> {
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly getRowId: (row: T) => string;
  readonly onRowClick?: (row: T) => void;
  readonly initialSort?: { readonly columnId: string; readonly desc?: boolean };
  readonly pageSize?: number;
  readonly emptyState?: ReactNode;
  readonly caption?: string;
}

type SortState = { readonly columnId: string; readonly desc: boolean } | null;

function compare(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right), "en", { numeric: true });
}

export function DataTable<T>({
  rows,
  columns,
  getRowId,
  onRowClick,
  initialSort,
  pageSize = 25,
  emptyState,
  caption,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState>(
    initialSort
      ? { columnId: initialSort.columnId, desc: initialSort.desc ?? false }
      : null,
  );
  const [page, setPage] = useState(0);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((candidate) => candidate.id === sort.columnId);
    if (!column?.sortValue) return rows;
    const sortValue = column.sortValue;
    return [...rows].sort((left, right) => {
      const result = compare(sortValue(left), sortValue(right));
      return sort.desc ? -result : result;
    });
  }, [columns, rows, sort]);

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = sortedRows.slice(
    currentPage * pageSize,
    currentPage * pageSize + pageSize,
  );

  function toggleSort(columnId: string) {
    setPage(0);
    setSort((previous) =>
      previous?.columnId === columnId
        ? { columnId, desc: !previous.desc }
        : { columnId, desc: false },
    );
  }

  if (rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="flex flex-col gap-3">
      <Table>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => {
              const sortable = Boolean(column.sortValue);
              const active = sort?.columnId === column.id;
              return (
                <TableHead
                  key={column.id}
                  className={cn(
                    "text-xs font-medium text-muted-foreground",
                    column.align === "right" && "text-right",
                    column.hideOnMobile && "hidden md:table-cell",
                  )}
                  aria-sort={
                    active ? (sort.desc ? "descending" : "ascending") : undefined
                  }
                >
                  {sortable ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className={cn(
                        "-mx-2 h-6 font-medium text-muted-foreground hover:text-foreground",
                        column.align === "right" && "ml-auto flex",
                        active && "text-foreground",
                      )}
                      onClick={() => toggleSort(column.id)}
                    >
                      {column.header}
                      {active ? (
                        sort.desc ? (
                          <ArrowDownIcon data-icon="inline-end" />
                        ) : (
                          <ArrowUpIcon data-icon="inline-end" />
                        )
                      ) : (
                        <ArrowUpDownIcon
                          data-icon="inline-end"
                          className="opacity-40"
                        />
                      )}
                    </Button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageRows.map((row) => (
            <TableRow
              key={getRowId(row)}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? "button" : undefined}
              className={cn(onRowClick && "cursor-pointer")}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <TableCell
                  key={column.id}
                  className={cn(
                    "py-2.5",
                    column.align === "right" && "text-right",
                    column.hideOnMobile && "hidden md:table-cell",
                    column.className,
                  )}
                >
                  {column.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {pageRows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={columns.length}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                No rows match the current filters.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      {sortedRows.length > pageSize ? (
        <div className="flex items-center justify-between gap-4 px-1">
          <p className="text-xs text-muted-foreground tabular">
            {currentPage * pageSize + 1}–
            {Math.min(sortedRows.length, (currentPage + 1) * pageSize)} of{" "}
            {sortedRows.length}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={currentPage === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              <ChevronLeftIcon />
            </Button>
            <span className="px-1 text-xs text-muted-foreground tabular">
              {currentPage + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={currentPage >= pageCount - 1}
              onClick={() =>
                setPage((value) => Math.min(pageCount - 1, value + 1))
              }
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
