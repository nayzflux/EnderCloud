"use client";

import { useQuery } from "@tanstack/react-query";
import { BoxesIcon, GitBranchIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { FilterBar, FilterSelect, ResultCount, SearchField } from "@/components/filter-bar";
import { KeyValue, KeyValueGrid, SectionTitle } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchVariants } from "@/lib/api";
import type { DashboardVariantGraph } from "@/lib/contracts";
import { formatBytes } from "@/lib/format";
import { buildVariantFlow, type VariantFlowNode } from "@/lib/variant-flow";

const VariantFlow = dynamic(
  () => import("./variant-flow").then((module) => module.VariantFlow),
  { ssr: false, loading: () => <Skeleton className="size-full" /> },
);

function checksum(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function LayerDetails({ node }: { readonly node: VariantFlowNode | undefined }) {
  if (!node) {
    return (
      <Empty className="min-h-64">
        <EmptyHeader>
          <EmptyMedia variant="icon"><GitBranchIcon /></EmptyMedia>
          <EmptyTitle>Select a layer</EmptyTitle>
          <EmptyDescription>Choose a card in the map to inspect what it contributes.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const { layer, variant } = node.data;
  const environment = Object.entries(layer.runtime.environment);
  return (
    <aside aria-live="polite" className="flex min-w-0 flex-col gap-5 xl:pl-6">
      <div>
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {variant ? "Final variant" : "Shared layer"}
        </p>
        <h2 className="mt-1 font-heading text-lg font-semibold">{layer.id}</h2>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{checksum(layer.checksum)}</p>
      </div>

      {variant ? (
        <>
          <KeyValueGrid>
            <KeyValue label="Selection">
              {variant.weight} weight · {Math.round((node.data.percentage ?? 0) * 100)}%
            </KeyValue>
            <KeyValue label="Revision">{variant.revision}</KeyValue>
            <KeyValue label="Effective image" mono wide>{variant.runtime.image}</KeyValue>
            <KeyValue label="Resources">
              {variant.runtime.cpu} vCPU · {formatBytes(variant.runtime.memoryBytes)}
            </KeyValue>
            <KeyValue label="Effective checksum" mono>{checksum(variant.checksum)}</KeyValue>
          </KeyValueGrid>
          <Separator />
        </>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionTitle>Layer contribution</SectionTitle>
        <KeyValueGrid>
          <KeyValue label="Image" mono>{layer.runtime.image ?? "Inherited"}</KeyValue>
          <KeyValue label="Memory">
            {layer.runtime.memoryBytes === undefined ? "Inherited" : formatBytes(layer.runtime.memoryBytes)}
          </KeyValue>
          <KeyValue label="CPU">{layer.runtime.cpu ?? "Inherited"}</KeyValue>
          <KeyValue label="Files">
            {layer.files.fileCount} · {formatBytes(layer.files.totalBytes)}
          </KeyValue>
        </KeyValueGrid>
        <div className="flex flex-wrap gap-1.5">
          {layer.files.roots.map((root) => <Badge key={root} variant="outline">{root}</Badge>)}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle count={environment.length}>Environment overrides</SectionTitle>
        {environment.length > 0 ? (
          <dl className="grid gap-2">
            {environment.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 text-xs">
                <dt className="truncate font-mono text-muted-foreground">{key}</dt>
                <dd className="truncate font-mono text-right" title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        ) : <p className="text-sm text-muted-foreground">No environment override in this layer.</p>}
      </section>
    </aside>
  );
}

function StackList({ graph }: { readonly graph: DashboardVariantGraph }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle count={graph.variants.length}>Resolved stacks</SectionTitle>
      <div className="grid gap-2">
        {graph.variants.map((variant) => (
          <div key={variant.id} className="flex flex-wrap items-center gap-2 border-b py-2 text-sm last:border-b-0">
            <span className="min-w-40 font-heading font-medium">{variant.id}</span>
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {variant.layers.map((layer, index) => (
                <span key={`${variant.id}:${layer}`} className="flex items-center gap-1.5">
                  {index > 0 ? <span aria-hidden>→</span> : null}
                  <code>{layer}</code>
                </span>
              ))}
            </span>
            <Badge variant="secondary" className="ml-auto">weight {variant.weight}</Badge>
          </div>
        ))}
      </div>
    </section>
  );
}

export function VariantExplorer({ groupId }: { readonly groupId: string }) {
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState("enabled");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["variants", groupId],
    queryFn: () => fetchVariants(groupId),
    staleTime: 30_000,
  });
  const model = useMemo(
    () => query.data
      ? buildVariantFlow(query.data, { search, enabledOnly: visibility === "enabled" })
      : { nodes: [], edges: [] },
    [query.data, search, visibility],
  );
  const selected = model.nodes.find((node) => node.id === selectedId) ?? model.nodes[0];
  const selectNode = useCallback((node: VariantFlowNode) => setSelectedId(node.id), []);

  if (query.isPending) return <Skeleton className="h-[70svh] min-h-[36rem] w-full rounded-xl" />;
  if (query.isError || !query.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Variant map unavailable</AlertTitle>
        <AlertDescription>{query.error?.message ?? "The group could not be loaded."}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <SearchField
          value={search}
          onChange={setSearch}
          label="Search variants and layers"
          placeholder="Variant or layer…"
        />
        <FilterSelect
          value={visibility}
          onChange={setVisibility}
          label="Filter variants"
          options={[
            { value: "enabled", label: "Enabled variants" },
            { value: "all", label: "All variants" },
          ]}
        />
        <ResultCount shown={model.nodes.length} total={query.data.layers.length} noun="layer" />
      </FilterBar>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="h-[62svh] min-h-[34rem] overflow-hidden rounded-xl bg-muted/30 ring-1 ring-border">
          {model.nodes.length > 0 ? (
            <VariantFlow model={model} onSelect={selectNode} selectedId={selected?.id} />
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon"><BoxesIcon /></EmptyMedia>
                <EmptyTitle>Nothing to draw</EmptyTitle>
                <EmptyDescription>Change the search or include disabled variants.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <LayerDetails node={selected} />
      </div>
      <Separator />
      <StackList graph={query.data} />
    </div>
  );
}
