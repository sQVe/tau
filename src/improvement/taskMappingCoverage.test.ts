import { expect, it } from 'vitest';

import { combinedReadability, decideCoverage } from './taskMapping.ts';
import type { Coverage, CoverageFacts, WorkerTranscript } from './taskMapping.ts';

const table: { rule: string; facts: CoverageFacts; coverage: Coverage }[] = [
  {
    rule: 'complete when every launched worker transcript is readable',
    facts: { mapped: true, malformed: false, workers: ['readable', 'readable'] },
    coverage: 'complete',
  },
  {
    rule: 'complete when the task launched no worker',
    facts: { mapped: true, malformed: false, workers: [] },
    coverage: 'complete',
  },
  {
    rule: 'managerOnly when a worker transcript is missing',
    facts: { mapped: true, malformed: false, workers: ['readable', 'missing'] },
    coverage: 'managerOnly',
  },
  {
    rule: 'managerOnly when a launch names no worker ID',
    facts: { mapped: true, malformed: false, workers: ['unknownId'] },
    coverage: 'managerOnly',
  },
  {
    rule: 'missing when no transcript maps',
    facts: { mapped: false, malformed: false, workers: [] },
    coverage: 'missing',
  },
  {
    rule: 'unknown when a worker transcript read failed',
    facts: { mapped: true, malformed: false, workers: ['missing', 'unreadable'] },
    coverage: 'unknown',
  },
  {
    rule: 'unknown when a manager transcript is malformed',
    facts: { mapped: true, malformed: true, workers: ['missing'] },
    coverage: 'unknown',
  },
];

it.each(table)('decideCoverage $rule', ({ facts, coverage }) => {
  expect(decideCoverage(facts)).toBe(coverage);
});

const readabilityTable: {
  rule: string;
  sessions: WorkerTranscript[];
  readability: WorkerTranscript;
}[] = [
  { rule: 'missing when the worker has no session', sessions: [], readability: 'missing' },
  { rule: 'missing when every session is missing', sessions: ['missing'], readability: 'missing' },
  {
    rule: 'readable when one session is readable and another is missing',
    sessions: ['readable', 'missing'],
    readability: 'readable',
  },
  {
    rule: 'unreadable when any session is unreadable',
    sessions: ['readable', 'unreadable', 'missing'],
    readability: 'unreadable',
  },
  {
    rule: 'readable when every session is readable',
    sessions: ['readable', 'readable'],
    readability: 'readable',
  },
];

it.each(readabilityTable)('combinedReadability $rule', ({ sessions, readability }) => {
  expect(combinedReadability(sessions)).toBe(readability);
});
