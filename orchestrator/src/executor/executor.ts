import type { VariantRuntimeSpec } from "../domain/types.ts";

export interface InstanceSpec {
  readonly hostId: string;
  readonly instanceId: string;
  readonly groupId: string;
  readonly variantId: string;
  readonly sessionId?: string;
  readonly templateLayers: readonly {
    readonly id: string;
    readonly checksum: string;
    readonly templatePath?: string;
  }[];
  readonly runtime: VariantRuntimeSpec;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CreatedInstance {
  readonly containerId: string;
  readonly runtimePath: string;
  readonly endpoint: string;
}

export interface RuntimeState {
  readonly exists: boolean;
  readonly running: boolean;
  readonly exitCode?: number;
  readonly status?: string;
}

export interface RuntimeInstance {
  readonly hostId: string;
  readonly containerId: string;
  readonly instanceId: string;
  readonly groupId: string;
  readonly variantId: string;
  readonly sessionId?: string;
  readonly running: boolean;
  readonly status: string;
}

export interface OrphanCleanupResult {
  readonly containerRemoved: boolean;
  readonly runtimeDirectoryRemoved: boolean;
}

export interface Executor {
  createInstance(spec: InstanceSpec): Promise<CreatedInstance>;
  stopInstance(target: InstanceTarget, timeoutSeconds: number): Promise<void>;
  deleteInstance(target: InstanceTarget): Promise<void>;
  deleteOrphanInstance(instance: RuntimeInstance): Promise<OrphanCleanupResult>;
  inspectInstance(target: InstanceTarget): Promise<RuntimeState>;
  listManagedInstances(hostId: string): Promise<readonly RuntimeInstance[]>;
}

export interface InstanceTarget {
  readonly hostId: string;
  readonly instanceId: string;
}
