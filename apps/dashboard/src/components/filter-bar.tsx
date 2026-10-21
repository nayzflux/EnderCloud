"use client";

import { SearchIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function FilterBar({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly label: string;
}) {
  return (
    <InputGroup className="w-full sm:w-72">
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear search"
            onClick={() => onChange("")}
          >
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export function FilterSelect({
  value,
  onChange,
  options,
  label,
  className,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly FilterOption[];
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <Select
      items={options as FilterOption[]}
      value={value}
      onValueChange={(next) => onChange((next as string | null) ?? options[0].value)}
    >
      <SelectTrigger aria-label={label} className={className ?? "w-44"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function ResultCount({
  shown,
  total,
  noun,
}: {
  readonly shown: number;
  readonly total: number;
  readonly noun: string;
}) {
  return (
    <p className="ml-auto text-xs text-muted-foreground tabular">
      {shown === total
        ? `${total} ${noun}${total === 1 ? "" : "s"}`
        : `${shown} of ${total} ${noun}${total === 1 ? "" : "s"}`}
    </p>
  );
}
