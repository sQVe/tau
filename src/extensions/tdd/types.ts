import type { RunnerResult } from './runner/types.js';

export interface Behavior {
  behavior: string;
  // One full name, or several when one behavior is proven by a few small tests together.
  testFullName: string | string[];
  files: string[];
}

export type InputHashes = Record<string, string | null>;

export interface EvidenceRecord {
  before: InputHashes;
  after: InputHashes;
  report: RunnerResult;
}

export interface RedRecord extends EvidenceRecord {
  // Set once the behavior reached GREEN against this RED.
  greened?: boolean;
  // Test-file hashes accepted after GREEN, so the full run can report those tests as edited.
  renewed?: InputHashes;
}

export interface EvidenceState {
  active: Behavior | null;
  reds: { behavior: Behavior; record: RedRecord }[];
  red: RedRecord | null;
  focusedPass: EvidenceRecord | null;
  fullPass: EvidenceRecord | null;
  latestRun: EvidenceRecord | null;
  // Every test that ever failed by name under the gate, kept across verified task boundaries.
  proven: { file: string; fullname: string }[];
  verified: boolean;
  gateOff: { since: string } | null;
}

export type Phase = 'locked' | 'red' | 'green' | 'verified';
