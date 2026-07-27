"use client";

import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { fetchCluster } from "@/lib/api";
import type { DashboardClusterSnapshot, DashboardGroup } from "@/lib/contracts";

export const refreshIntervals = [
  { value: 0, label: "Paused" },
  { value: 2_000, label: "2s" },
  { value: 5_000, label: "5s" },
  { value: 15_000, label: "15s" },
  { value: 60_000, label: "1m" },
] as const;

interface ClusterContextValue {
  readonly snapshot: DashboardClusterSnapshot | undefined;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  readonly refresh: () => void;
  readonly refreshInterval: number;
  readonly setRefreshInterval: (interval: number) => void;
}

const ClusterContext = createContext<ClusterContextValue | null>(null);

export function ClusterProvider({ children }: { readonly children: ReactNode }) {
  const [refreshInterval, setRefreshInterval] = useState<number>(5_000);
  const query = useQuery({
    queryKey: ["cluster"],
    queryFn: fetchCluster,
    refetchInterval: refreshInterval === 0 ? false : refreshInterval,
    refetchIntervalInBackground: false,
    // Keep the last good topology on screen while the orchestrator reconnects.
    placeholderData: (previous) => previous,
  });

  const value = useMemo<ClusterContextValue>(
    () => ({
      snapshot: query.data,
      isPending: query.isPending,
      isFetching: query.isFetching,
      isError: query.isError,
      error: query.error,
      refresh: () => void query.refetch(),
      refreshInterval,
      setRefreshInterval,
    }),
    [query, refreshInterval],
  );

  return (
    <ClusterContext.Provider value={value}>{children}</ClusterContext.Provider>
  );
}

export function useCluster(): ClusterContextValue {
  const context = useContext(ClusterContext);
  if (!context) {
    throw new Error("useCluster must be used within a ClusterProvider.");
  }
  return context;
}

/** Flattens every instance of the snapshot with its owning group attached. */
export function useAllInstances() {
  const { snapshot } = useCluster();
  return useMemo(
    () =>
      (snapshot?.groups ?? []).flatMap((group) =>
        group.instances.map((instance) => ({ group, instance })),
      ),
    [snapshot],
  );
}

/** Flattens every session of the snapshot with its owning group attached. */
export function useAllSessions() {
  const { snapshot } = useCluster();
  return useMemo(
    () =>
      (snapshot?.groups ?? []).flatMap((group) =>
        group.sessions.map((session) => ({ group, session })),
      ),
    [snapshot],
  );
}

/** Groups that run matchmaking, i.e. the only ones with a queue. */
export function matchmakingGroups(
  groups: readonly DashboardGroup[],
): readonly DashboardGroup[] {
  return groups.filter((group) => group.type === "minigame");
}
