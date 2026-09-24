import type { ModelOptions } from "./provider";

export interface ModelOptionsCollectorContext {
  environment: Record<string, string>;
  command: string;
  signal?: AbortSignal;
}

export type ProviderModelOptionsCollector = (context: ModelOptionsCollectorContext) => Promise<ModelOptions>;
