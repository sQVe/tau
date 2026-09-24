import type { RunnerResult } from './runner/types.js';

export interface Behavior {
  behavior: string;
  testFullName: string | string[];
  files: string[];
}

export type TestScope = 'focused' | 'full';

export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface ObservationResult {
  kind: RunnerResult['kind'];
  scope: TestScope;
  freshness: Freshness;
  inputs: { before: string | null; after: string | null };
  runPath: string | undefined;
  report: RunnerResult;
  hint: string | undefined;
}

export interface TestObservation {
  run: (
    requested: Behavior,
    scope: TestScope,
    signal?: AbortSignal,
    onStart?: (behavior: Behavior) => void,
  ) => Promise<ObservationResult>;
  checkpoint: (productionEdit: boolean) => Promise<string | undefined>;
}
