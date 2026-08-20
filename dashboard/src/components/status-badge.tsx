import type { ComponentProps, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { humanizeState } from "@/lib/format";
import {
  availabilityTone,
  hostAdminTone,
  hostHealthTone,
  lifecycleTone,
  sessionPlayerTone,
  sessionTone,
  toneBadgeClass,
  toneDotClass,
  workTone,
  type Tone,
} from "@/lib/status";
import type {
  AvailabilityState,
  ExecutionHostAdminState,
  ExecutionHostHealthState,
  LifecycleState,
  SessionPlayerState,
  SessionState,
} from "@/lib/contracts";
import { cn } from "@/lib/utils";

interface StatusBadgeProps extends ComponentProps<typeof Badge> {
  readonly tone: Tone;
  /** A node, not just text, so live durations can be rendered inside a badge. */
  readonly label: ReactNode;
  readonly dot?: boolean;
}

export function StatusBadge({
  tone,
  label,
  dot = true,
  className,
  ...props
}: StatusBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn("gap-1.5 font-medium", toneBadgeClass[tone], className)}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", toneDotClass[tone])}
        />
      ) : null}
      {label}
    </Badge>
  );
}

export function LifecycleBadge({ state }: { readonly state: LifecycleState }) {
  return <StatusBadge tone={lifecycleTone(state)} label={humanizeState(state)} />;
}

export function AvailabilityBadge({
  state,
}: {
  readonly state: AvailabilityState;
}) {
  return (
    <StatusBadge
      tone={availabilityTone(state)}
      label={humanizeState(state)}
      dot={false}
    />
  );
}

export function HostHealthBadge({
  state,
}: {
  readonly state: ExecutionHostHealthState;
}) {
  return <StatusBadge tone={hostHealthTone(state)} label={humanizeState(state)} />;
}

export function HostAdminBadge({
  state,
}: {
  readonly state: ExecutionHostAdminState;
}) {
  return (
    <StatusBadge
      tone={hostAdminTone(state)}
      label={humanizeState(state)}
      dot={false}
    />
  );
}

export function SessionStateBadge({ state }: { readonly state: SessionState }) {
  return <StatusBadge tone={sessionTone(state)} label={humanizeState(state)} />;
}

export function SessionPlayerBadge({
  state,
}: {
  readonly state: SessionPlayerState;
}) {
  return (
    <StatusBadge
      tone={sessionPlayerTone(state)}
      label={humanizeState(state)}
      dot={false}
    />
  );
}

export function WorkStateBadge({ state }: { readonly state: string }) {
  return <StatusBadge tone={workTone(state)} label={humanizeState(state)} />;
}

export function GroupTypeBadge({ type }: { readonly type: "hub" | "minigame" }) {
  return (
    <Badge variant="outline" className="font-mono text-[0.65rem] uppercase">
      {type === "hub" ? "hub" : "minigame"}
    </Badge>
  );
}
