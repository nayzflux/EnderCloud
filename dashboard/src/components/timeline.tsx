"use client";

import type { ReactNode } from "react";
import { Countdown, Elapsed } from "@/components/live-time";
import { formatDateTime, formatDuration, formatTime } from "@/lib/format";
import { toneDotClass, toneTextClass, type Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

export type StepState = "done" | "current" | "pending" | "skipped";

export interface TimelineStep {
  readonly id: string;
  readonly label: string;
  /** `null` while the step has not been reached. */
  readonly at: string | null;
  readonly tone?: Tone;
  /** Extra line under the label — a deadline, an identifier, a reason. */
  readonly hint?: ReactNode;
  /** Shown instead of `pending` when a step will never be reached. */
  readonly skippedLabel?: string;
}

interface TimelineProps {
  readonly steps: readonly TimelineStep[];
  /** Deadline the entity is currently racing against, if any. */
  readonly deadline?: {
    readonly label: string;
    readonly at: string | null;
    readonly tone?: Tone;
  };
  /** Marks the run as terminal, so the last reached step stops counting up. */
  readonly settled?: boolean;
}

function stateOf(
  step: TimelineStep,
  index: number,
  lastReached: number,
  settled: boolean,
): StepState {
  if (step.at) return index === lastReached && !settled ? "current" : "done";
  return index < lastReached ? "skipped" : "pending";
}

/**
 * A lifecycle as an actual timeline rather than a grid of labelled instants:
 * the order of the steps is the order they happen in, each one shows how long
 * it took to get there, and the step the entity is sitting on keeps counting up
 * on its own.
 */
export function Timeline({ steps, deadline, settled = false }: TimelineProps) {
  const lastReached = steps.reduce(
    (last, step, index) => (step.at ? index : last),
    -1,
  );

  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const state = stateOf(step, index, lastReached, settled);
        const isLast = index === steps.length - 1;
        const tone: Tone = step.tone ?? (state === "pending" ? "neutral" : "success");

        // Time spent getting here, measured from the previous reached step.
        const previousAt = steps
          .slice(0, index)
          .reduce<string | null>((last, candidate) => candidate.at ?? last, null);
        const delta =
          step.at && previousAt
            ? Date.parse(step.at) - Date.parse(previousAt)
            : null;

        return (
          <li key={step.id} className="relative flex gap-3 pb-4 last:pb-0">
            {!isLast ? (
              <span
                aria-hidden
                className={cn(
                  "absolute top-3 bottom-0 left-[5px] w-px",
                  state === "pending" ? "bg-border" : "bg-border",
                )}
              />
            ) : null}

            <span
              aria-hidden
              className={cn(
                "relative z-10 mt-1 size-2.5 shrink-0 rounded-full ring-4 ring-card",
                state === "pending" && "bg-muted-foreground/30",
                state === "skipped" && "bg-muted-foreground/30",
                state === "done" && toneDotClass[tone],
                state === "current" &&
                  cn(toneDotClass[tone], "animate-pulse ring-2 ring-offset-2 ring-offset-card"),
              )}
            />

            <div className="-mt-0.5 min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span
                  className={cn(
                    "text-sm",
                    state === "pending" || state === "skipped"
                      ? "text-muted-foreground"
                      : "font-medium",
                    state === "current" && toneTextClass[tone],
                  )}
                >
                  {step.label}
                </span>

                {step.at ? (
                  <span
                    className="font-mono text-xs text-muted-foreground tabular"
                    title={formatDateTime(step.at)}
                  >
                    {formatTime(step.at)}
                    {delta !== null ? (
                      <span className="ml-2 text-muted-foreground/70">
                        +{formatDuration(delta)}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground/70">
                    {state === "skipped" ? (step.skippedLabel ?? "skipped") : "pending"}
                  </span>
                )}
              </div>

              {state === "current" ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <Elapsed value={step.at} className="tabular" /> in this state
                </p>
              ) : null}

              {step.hint ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {step.hint}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}

      {deadline?.at ? (
        <li className="relative flex gap-3 pt-1">
          <span
            aria-hidden
            className={cn(
              "relative z-10 mt-1 size-2.5 shrink-0 rounded-full border-2 border-dashed bg-card",
              deadline.tone === "danger"
                ? "border-destructive"
                : "border-muted-foreground/60",
            )}
          />
          <div className="-mt-0.5 flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-sm text-muted-foreground">{deadline.label}</span>
            <span className="font-mono text-xs tabular" title={formatDateTime(deadline.at)}>
              <Countdown
                value={deadline.at}
                className={cn(
                  deadline.tone === "danger" && toneTextClass.danger,
                )}
              />
            </span>
          </div>
        </li>
      ) : null}
    </ol>
  );
}
