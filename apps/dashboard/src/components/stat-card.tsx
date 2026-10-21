import type { ComponentType, ReactNode } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { toneTextClass, type Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

interface StatCardProps {
  readonly label: string;
  /** Numbers are localised; anything else is rendered as-is, live times included. */
  readonly value: number | ReactNode;
  readonly icon?: ComponentType<{ className?: string }>;
  readonly hint?: ReactNode;
  readonly tone?: Tone;
  /** 0–100; renders a thin capacity track under the value. */
  readonly progress?: number;
  readonly progressLabel?: string;
}

export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  tone = "neutral",
  progress,
  progressLabel,
}: StatCardProps) {
  return (
    <Card size="sm" className="gap-2">
      <CardHeader>
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </CardTitle>
        {Icon ? (
          <CardAction>
            <Icon
              className={cn("size-4", tone === "neutral" ? "text-muted-foreground" : toneTextClass[tone])}
            />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "font-heading text-2xl leading-none font-semibold tabular",
              tone !== "neutral" && toneTextClass[tone],
            )}
          >
            {typeof value === "number" ? formatNumber(value) : value}
          </span>
          {hint ? (
            <span className="text-xs text-muted-foreground">{hint}</span>
          ) : null}
        </div>
        {progress === undefined ? null : (
          <div className="flex flex-col gap-1">
            <div
              className="h-1 w-full overflow-hidden rounded-full bg-muted"
              role="presentation"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500",
                  tone === "neutral" ? "bg-foreground/60" : `bg-current ${toneTextClass[tone]}`,
                )}
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </div>
            {progressLabel ? (
              <span className="text-[0.7rem] text-muted-foreground tabular">
                {progressLabel}
              </span>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function StatCardSkeleton() {
  return (
    <Card size="sm" className="gap-2">
      <CardHeader>
        <Skeleton className="h-3 w-20" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Skeleton className="h-6 w-12" />
        <Skeleton className="h-1 w-full" />
      </CardContent>
    </Card>
  );
}
