import type { VariantRuntimeSpec } from "../domain/types.ts";

export interface InstanceSpec {
  readonly instanceId: string;
  readonly groupId: string;
  readonly variantId: string;
  readonly sessionId?: string;
  readonly templatePath: string;
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
  readonly containerId: string;
  readonly instanceId: string;
  readonly groupId: string;
  readonly variantId: string;
  readonly sessionId?: string;
  readonly running: boolean;
  readonly status: string;
}

export interface Executor {
  createInstance(spec: InstanceSpec): Promise<CreatedInstance>;
  stopInstance(instanceId: string, timeoutSeconds: number): Promise<void>;
  deleteInstance(instanceId: string): Promise<void>;
  inspectInstance(instanceId: string): Promise<RuntimeState>;
  listManagedInstances(): Promise<readonly RuntimeInstance[]>;
}
