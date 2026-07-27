"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface CopyableIdProps {
  readonly value: string;
  /** Visible text; defaults to the full value. */
  readonly display?: string;
  readonly className?: string;
  readonly label?: string;
}

/**
 * Monospace identifier with a copy affordance. Internal ids are 16 opaque
 * characters, so being able to grab one without selecting text matters.
 */
export function CopyableId({
  value,
  display,
  className,
  label = "identifier",
}: CopyableIdProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`Copied ${label}`, { description: value });
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Could not access the clipboard");
    }
  }

  return (
    <span className={cn("group/id inline-flex items-center gap-1", className)}>
      <span className="truncate font-mono text-xs">{display ?? value}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Copy ${label}`}
              className="opacity-0 transition-opacity group-hover/id:opacity-100 focus-visible:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                void copy();
              }}
            />
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </TooltipTrigger>
        <TooltipContent>Copy {label}</TooltipContent>
      </Tooltip>
    </span>
  );
}
