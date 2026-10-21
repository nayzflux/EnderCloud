const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeStyle: "medium",
  timeZone: "UTC",
});

const numberFormatter = new Intl.NumberFormat("en-GB");

/** Formats a signed second offset as a compact `2h 05m`-style duration. */
function compactDuration(totalSeconds: number): string {
  const seconds = Math.abs(Math.trunc(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${String(hours % 24).padStart(2, "0")}h`;
}

/** `il y a 3 min` equivalent: `3m 20s ago`, `in 45s`, or `just now`. */
export function formatRelativeTime(
  value: string | null | undefined,
  now = Date.now(),
): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  const deltaSeconds = Math.round((now - timestamp) / 1_000);
  if (Math.abs(deltaSeconds) < 5) return "just now";
  if (deltaSeconds < 0) return `in ${compactDuration(deltaSeconds)}`;
  return `${compactDuration(deltaSeconds)} ago`;
}

/** Elapsed time since `value`, without the `ago` suffix — for age columns. */
export function formatAge(
  value: string | null | undefined,
  now = Date.now(),
): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  return compactDuration(Math.max(0, (now - timestamp) / 1_000));
}

/** Time left before `value`, or `overdue` once the deadline has passed. */
export function formatCountdown(
  value: string | null | undefined,
  now = Date.now(),
): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  const deltaSeconds = (timestamp - now) / 1_000;
  if (deltaSeconds <= 0) return `overdue by ${compactDuration(deltaSeconds)}`;
  return compactDuration(deltaSeconds);
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return compactDuration(milliseconds / 1_000);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  return `${dateTimeFormatter.format(timestamp)} UTC`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  return timeFormatter.format(timestamp);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const gibibytes = bytes / 1024 ** 3;
  if (gibibytes >= 1) {
    return `${gibibytes.toFixed(gibibytes % 1 === 0 ? 0 : 1)} GiB`;
  }
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatPercent(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

/** Safe percentage for progress bars, clamped to 0–100. */
export function ratio(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

/** Turns `WAITING_FOR_INSTANCE` into `Waiting for instance`. */
export function humanizeState(state: string): string {
  const lower = state.toLowerCase().replaceAll("_", " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Shortens a 16-character internal id for dense table cells. */
export function shortId(id: string, visible = 8): string {
  return id.length <= visible ? id : `${id.slice(0, visible)}…`;
}
