import { expect, it } from 'vitest';

import { decideWatchStart } from './watchStart.js';
import type { WatchStartFacts } from './watchStart.js';

const table: { name: string; facts: WatchStartFacts; starts: boolean }[] = [
  {
    name: 'starts for an open pull request with auto-merge on',
    facts: { state: 'OPEN', autoMergeEnabled: true },
    starts: true,
  },
  {
    name: 'starts for a pull request that already merged',
    facts: { state: 'MERGED', autoMergeEnabled: false },
    starts: true,
  },
  {
    name: 'skips an open pull request without auto-merge',
    facts: { state: 'OPEN', autoMergeEnabled: false },
    starts: false,
  },
  {
    name: 'skips a closed pull request without auto-merge',
    facts: { state: 'CLOSED', autoMergeEnabled: false },
    starts: false,
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, starts }) => {
  expect(decideWatchStart(facts)).toBe(starts);
});
