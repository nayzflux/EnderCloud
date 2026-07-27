export function formatRelativeTime(
  value: string | null,
  now = Date.now(),
): string {
  if (!value) return "—";
  const deltaSeconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1_000));
  if (deltaSeconds < 5) return "à l’instant";
  if (deltaSeconds < 60) return `il y a ${deltaSeconds} s`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} s`;
  return `${Math.round(milliseconds / 60_000)} min`;
}

export function formatBytes(bytes: number): string {
  const gibibytes = bytes / 1024 ** 3;
  if (gibibytes >= 1) return `${gibibytes.toFixed(gibibytes % 1 ? 1 : 0)} Gio`;
  return `${Math.round(bytes / 1024 ** 2)} Mio`;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}
