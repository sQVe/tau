import { expect, it } from 'vitest';

import { decideEndpointPrune } from './endpointPruneDecision.js';
import type { EndpointPruneFacts } from './endpointPruneDecision.js';

const hour = 60 * 60 * 1000;
const lastWrite = Date.UTC(2026, 9, 1);

const facts = (given: Partial<EndpointPruneFacts>): EndpointPruneFacts => ({
  directories: ['absent'],
  lastWrite: undefined,
  fixNeedsRef: false,
  now: lastWrite + hour,
  ...given,
});

it.each([
  { name: 'no worktree holds the review directory', facts: facts({}), prune: true },
  {
    name: 'a worktree holds a capture record',
    facts: facts({ directories: ['absent', 'record'] }),
    prune: false,
  },
  {
    name: 'a worktree holds an old capture record',
    facts: facts({ directories: ['record'], lastWrite, now: lastWrite + 1000 * hour }),
    prune: false,
  },
  {
    name: 'a worktree could not be read',
    facts: facts({ directories: ['unknown', 'absent'] }),
    prune: false,
  },
  {
    name: 'a fix capture may compare against the deleted review',
    facts: facts({ fixNeedsRef: true }),
    prune: false,
  },
  {
    name: 'a fix capture may compare against an interrupted review',
    facts: facts({
      directories: ['noRecord'],
      lastWrite,
      now: lastWrite + 48 * hour,
      fixNeedsRef: true,
    }),
    prune: false,
  },
  {
    name: 'a directory with no record was written under a day ago',
    facts: facts({ directories: ['noRecord'], lastWrite, now: lastWrite + 24 * hour - 1 }),
    prune: false,
  },
  {
    name: 'a directory with no record was last written a day ago',
    facts: facts({ directories: ['noRecord'], lastWrite, now: lastWrite + 24 * hour }),
    prune: true,
  },
  {
    name: 'a directory with no record has no known write time',
    facts: facts({ directories: ['noRecord'], now: lastWrite + 48 * hour }),
    prune: false,
  },
  {
    name: 'a directory with no record and an unreadable worktree',
    facts: facts({ directories: ['noRecord', 'unknown'], lastWrite, now: lastWrite + 48 * hour }),
    prune: false,
  },
])('prune is $prune when $name', ({ facts: given, prune }) => {
  expect(decideEndpointPrune(given)).toBe(prune);
});
