import { expect, it } from 'vitest';

import { decideCoverage } from './taskMapping.ts';
import type { Coverage, CoverageFacts } from './taskMapping.ts';

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
