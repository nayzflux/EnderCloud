export interface HostPlacementCandidate {
  readonly id: string;
  readonly allocatableCpu: number;
  readonly allocatableMemoryBytes: number;
  readonly reservedCpu: number;
  readonly reservedMemoryBytes: number;
}

export interface PlacementRequest {
  readonly cpu: number;
  readonly memoryBytes: number;
}

// Choose the least-loaded host by dominant reserved resource share.
export function selectExecutionHost(
  candidates: readonly HostPlacementCandidate[],
  request: PlacementRequest,
): HostPlacementCandidate | null {
  const feasible = candidates.filter((host) =>
    host.allocatableCpu - host.reservedCpu >= request.cpu &&
    host.allocatableMemoryBytes - host.reservedMemoryBytes >= request.memoryBytes
  );
  feasible.sort((left, right) => {
    const leftShare = Math.max(
      left.reservedCpu / left.allocatableCpu,
      left.reservedMemoryBytes / left.allocatableMemoryBytes,
    );
    const rightShare = Math.max(
      right.reservedCpu / right.allocatableCpu,
      right.reservedMemoryBytes / right.allocatableMemoryBytes,
    );
    return leftShare - rightShare || left.id.localeCompare(right.id);
  });
  return feasible[0] ?? null;
}
