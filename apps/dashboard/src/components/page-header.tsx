import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-3",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

interface KeyValueProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
  readonly wide?: boolean;
}

export function KeyValue({ label, children, mono, wide }: KeyValueProps) {
  return (
    <div className={cn("min-w-0 space-y-0.5", wide && "col-span-full")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-sm wrap-break-word",
          mono && "font-mono text-xs leading-5",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

export function KeyValueGrid({
  children,
  columns = 2,
}: {
  readonly children: ReactNode;
  readonly columns?: 2 | 3;
}) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-3",
        columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3",
      )}
    >
      {children}
    </dl>
  );
}

export function SectionTitle({
  children,
  count,
}: {
  readonly children: ReactNode;
  readonly count?: number;
}) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
      {count === undefined ? null : (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground tabular">
          {count}
        </span>
      )}
    </h3>
  );
}
