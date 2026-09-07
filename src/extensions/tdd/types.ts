import type { RunnerResult } from './runner/types.js';

export interface Behavior {
  behavior: string;
  testFullName: string;
  files: string[];
}

export type InputHashes = Record<string, string | null>;

export interface EvidenceRecord {
  before: InputHashes;
  after: InputHashes;
  report: RunnerResult;
}

export interface EvidenceState {
  active: Behavior | null;
  red: EvidenceRecord | null;
  focusedPass: EvidenceRecord | null;
  fullPass: EvidenceRecord | null;
  latestRun: EvidenceRecord | null;
}
