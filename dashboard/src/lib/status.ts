import type {
  AvailabilityState,
  DashboardInstance,
  LifecycleState,
  SessionPlayerState,
  SessionState,
} from "./contracts";

/**
 * Semantic tone shared by every status surface (badges, dots, topology nodes,
 * chart series) so the same state always reads the same way.
 */
export type Tone = "neutral" | "success" | "warning" | "info" | "danger";

export const toneBadgeClass: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/12 text-success dark:bg-success/20",
  warning: "bg-warning/12 text-warning dark:bg-warning/20",
  info: "bg-info/12 text-info dark:bg-info/20",
  danger: "bg-destructive/12 text-destructive dark:bg-destructive/20",
};

export const toneDotClass: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  danger: "bg-destructive",
};

export const toneTextClass: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  info: "text-info",
  danger: "text-destructive",
};

export const toneBorderClass: Record<Tone, string> = {
  neutral: "ring-foreground/10",
  success: "ring-success/40",
  warning: "ring-warning/40",
  info: "ring-info/40",
  danger: "ring-destructive/40",
};

export const toneChartColor: Record<Tone, string> = {
  neutral: "var(--muted-foreground)",
  success: "var(--success)",
  warning: "var(--warning)",
  info: "var(--info)",
  danger: "var(--destructive)",
};

const lifecycleTones: Record<LifecycleState, Tone> = {
  CREATING: "info",
  STARTING: "info",
  RUNNING: "success",
  DRAINING: "warning",
  STOPPING: "warning",
  STOPPED: "neutral",
  FAILED: "danger",
  ORPHANED: "danger",
};

const sessionTones: Record<SessionState, Tone> = {
  FORMING: "info",
  WAITING_FOR_INSTANCE: "warning",
  TRANSFERRING: "info",
  WAITING: "warning",
  STARTING: "info",
  RUNNING: "success",
  FINISHED: "neutral",
  CANCELLED: "neutral",
  FAILED: "danger",
};

const sessionPlayerTones: Record<SessionPlayerState, Tone> = {
  SELECTED: "info",
  TRANSFERRING: "warning",
  CONNECTED: "success",
  LEFT: "neutral",
};

const availabilityTones: Record<AvailabilityState, Tone> = {
  OPEN: "success",
  RESERVED: "info",
};

export function lifecycleTone(state: LifecycleState): Tone {
  return lifecycleTones[state] ?? "neutral";
}

export function sessionTone(state: SessionState): Tone {
  return sessionTones[state] ?? "neutral";
}

export function sessionPlayerTone(state: SessionPlayerState): Tone {
  return sessionPlayerTones[state] ?? "neutral";
}

export function availabilityTone(state: AvailabilityState): Tone {
  return availabilityTones[state] ?? "neutral";
}

/** Command and transfer states are open-ended strings in the contract. */
export function workTone(state: string): Tone {
  const normalized = state.toUpperCase();
  if (normalized === "FAILED" || normalized === "EXPIRED") return "danger";
  if (normalized === "COMPLETED" || normalized === "SUCCEEDED") return "success";
  if (normalized === "PENDING" || normalized === "SCHEDULED") return "warning";
  return "info";
}

/** Instances an operator should look at first. */
export function needsAttention(instance: DashboardInstance): boolean {
  return (
    instance.lifecycleState === "FAILED" ||
    instance.lifecycleState === "ORPHANED" ||
    instance.lifecycleState === "DRAINING" ||
    instance.lifecycleState === "STOPPING"
  );
}

export function isWarm(instance: DashboardInstance): boolean {
  return (
    instance.lifecycleState === "RUNNING" && instance.availabilityState === "OPEN"
  );
}

export function isStarting(instance: DashboardInstance): boolean {
  return (
    instance.lifecycleState === "CREATING" || instance.lifecycleState === "STARTING"
  );
}

export type InstanceFilter =
  | "all"
  | "warm"
  | "reserved"
  | "starting"
  | "attention";

export const instanceFilters: readonly {
  readonly value: InstanceFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All states" },
  { value: "warm", label: "Warm pool" },
  { value: "reserved", label: "Reserved" },
  { value: "starting", label: "Starting" },
  { value: "attention", label: "Needs attention" },
];

export function matchesInstanceFilter(
  instance: DashboardInstance,
  filter: InstanceFilter,
): boolean {
  switch (filter) {
    case "warm":
      return isWarm(instance);
    case "reserved":
      return instance.availabilityState === "RESERVED";
    case "starting":
      return isStarting(instance);
    case "attention":
      return needsAttention(instance);
    case "all":
      return true;
  }
}
