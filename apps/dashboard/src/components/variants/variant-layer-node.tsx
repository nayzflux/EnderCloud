"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { BoxIcon, Layers3Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { VariantFlowNode } from "@/lib/variant-flow";
import { cn } from "@/lib/utils";

export function VariantLayerNode({ data, selected }: NodeProps<VariantFlowNode>) {
  const final = data.kind === "final" && data.variant;
  return (
    <button
      type="button"
      aria-label={`Inspect ${final ? "final variant" : "layer"} ${data.layer.id}`}
      aria-pressed={selected}
      onClick={data.onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onSelect?.();
        }
      }}
      className={cn(
        "relative size-full rounded-xl bg-card text-left text-card-foreground ring-1 ring-border transition-[box-shadow,transform] focus-visible:outline-none",
        "before:absolute before:inset-0 before:translate-x-1 before:translate-y-1 before:rounded-xl before:bg-muted before:ring-1 before:ring-border",
        "after:absolute after:inset-0 after:translate-x-0.5 after:translate-y-0.5 after:rounded-xl after:bg-card after:ring-1 after:ring-border",
        selected && "ring-2 ring-ring",
      )}
    >
      <Handle id="in" type="target" position={Position.Left} />
      <div className="relative z-10 flex size-full flex-col justify-between rounded-xl bg-card p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[0.65rem] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              {final ? "Final variant" : `Layer ${data.depth + 1}`}
            </p>
            <p className="mt-1 truncate font-heading text-sm font-semibold">
              {data.layer.id}
            </p>
          </div>
          {final ? (
            <BoxIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Layers3Icon className="size-4 shrink-0 text-muted-foreground" />
          )}
        </div>
        <div className="flex items-end justify-between gap-2">
          <span className="text-[0.7rem] text-muted-foreground tabular">
            {data.layer.files.fileCount} files
          </span>
          {final ? (
            <div className="flex items-center gap-1.5">
              {final.enabled ? null : <Badge variant="outline">disabled</Badge>}
              <Badge variant="secondary">
                {final.weight} · {Math.round((data.percentage ?? 0) * 100)}%
              </Badge>
            </div>
          ) : null}
        </div>
      </div>
      <Handle id="out" type="source" position={Position.Right} />
    </button>
  );
}
