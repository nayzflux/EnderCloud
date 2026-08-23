import { cn } from "@/lib/utils";

type BrandMarkProps = {
  className?: string;
  showName?: boolean;
};

export function BrandMark({ className, showName = true }: BrandMarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <svg
        aria-hidden="true"
        className="size-7 shrink-0"
        viewBox="0 0 32 32"
        fill="none"
      >
        <path
          d="M4 5H26V11H11V14H24V20H11V21H28V27H4V5Z"
          fill="currentColor"
        />
        <path d="M22 5H28V11H22V5Z" className="fill-signal" />
      </svg>
      {showName ? (
        <span className="text-sm font-semibold tracking-[-0.02em]">
          EnderCloud
        </span>
      ) : null}
    </span>
  );
}
