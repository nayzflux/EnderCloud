"use client";

import { useNow } from "@/lib/clock";
import {
  formatAge,
  formatCountdown,
  formatDateTime,
  formatRelativeTime,
} from "@/lib/format";

/**
 * Leaf components for anything that measures elapsed time.
 *
 * Each one subscribes to the shared clock on its own, so a table of two hundred
 * rows re-renders only its time cells every second instead of the whole table.
 * They also carry the absolute instant as a tooltip and in `dateTime`, so the
 * exact value stays one hover away.
 */

interface LiveTimeProps {
  readonly value: string | null | undefined;
  readonly className?: string;
  /** Rendered when there is no timestamp to show. */
  readonly fallback?: string;
}

function useRendered(
  value: string | null | undefined,
  format: (value: string, now: number) => string,
): string | null {
  const now = useNow();
  if (!value) return null;
  // The clock is anchored by the API layer, so this only bites before the very
  // first payload — when there is nothing to measure anyway.
  if (now === 0) return null;
  return format(value, now);
}

function Rendered({
  value,
  text,
  className,
  fallback,
}: LiveTimeProps & { readonly text: string | null }) {
  if (!value || text === null) {
    return <span className={className}>{fallback ?? "—"}</span>;
  }
  return (
    <time dateTime={value} title={formatDateTime(value)} className={className}>
      {text}
    </time>
  );
}

/** Time since `value`, without a suffix: `3m 20s`. */
export function Elapsed({ value, className, fallback }: LiveTimeProps) {
  const text = useRendered(value, formatAge);
  return (
    <Rendered
      value={value}
      text={text}
      className={className}
      fallback={fallback}
    />
  );
}

/** Time since `value`, as prose: `3m 20s ago`, `in 45s`, `just now`. */
export function RelativeTime({ value, className, fallback }: LiveTimeProps) {
  const text = useRendered(value, formatRelativeTime);
  return (
    <Rendered
      value={value}
      text={text}
      className={className}
      fallback={fallback}
    />
  );
}

/** Time left before `value`, or how far past it we are. */
export function Countdown({ value, className, fallback }: LiveTimeProps) {
  const text = useRendered(value, formatCountdown);
  return (
    <Rendered
      value={value}
      text={text}
      className={className}
      fallback={fallback}
    />
  );
}
