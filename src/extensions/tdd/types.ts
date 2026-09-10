import type { RunnerResult } from './runner/types.js';

export interface Behavior {
  behavior: string;

  // When several tests prove one behavior, every named test must fail in RED and pass in GREEN.
  testFullName: string | string[];
  files: string[];
}

export type InputHashes = Record<string, string | null>;

export interface RedRecord {
  behavior: Behavior;
  report: RunnerResult;
  testHashes: InputHashes;
  greenTree: string | null;
  edited: boolean;

  // Each behavior remembers its last focused phase when another behavior becomes active.
  phase: 'locked' | 'red' | 'green';
}

export interface EvidenceState {
  active: Behavior | null;
  phase: Phase;
  reds: RedRecord[];
  verifiedTree: string | null;

  // Keep tests that failed by name under the gate, even after a task reaches verified.
  proven: { file: string; fullname: string }[];
  gateOff: { since: string } | null;
}

export type Phase = 'locked' | 'red' | 'green' | 'verified';
