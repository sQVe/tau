import type { RunnerResult } from './runner/types.js';

export interface Behavior {
  behavior: string;
  // One full name, or several when one behavior is proven by a few small tests together.
  testFullName: string | string[];
  files: string[];
}

export type InputHashes = Record<string, string | null>;

export interface RedRecord {
  behavior: Behavior;
  report: RunnerResult;
  testHashes: InputHashes;
  edited: boolean;
  // Each behavior remembers its last focused phase when another behavior becomes active.
  phase: 'locked' | 'red' | 'green';
}

export interface EvidenceState {
  active: Behavior | null;
  phase: Phase;
  reds: RedRecord[];
  verifiedTree: string | null;
  // Every test that ever failed by name under the gate, kept across verified task boundaries.
  proven: { file: string; fullname: string }[];
  gateOff: { since: string } | null;
}

export type Phase = 'locked' | 'red' | 'green' | 'verified';
