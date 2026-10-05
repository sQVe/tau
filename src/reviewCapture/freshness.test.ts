import { expect, it } from 'vitest';

import { decideFreshness } from './freshness.js';
import type { FreshnessFacts } from './freshness.js';

const recorded = { hash: 'hash-one', head: 'head-one' };

const facts = (current: Partial<FreshnessFacts>): FreshnessFacts => ({
  recorded,
  current: { hash: 'hash-one', head: 'head-one' },
  captureErrors: [],
  ...current,
});

it.each([
  { facts: facts({}), status: 'fresh', reasonCount: 0 },
  {
    facts: facts({ current: { hash: 'hash-two', head: 'head-one' } }),
    status: 'stale',
    reasonCount: 1,
  },
  {
    facts: facts({ current: { hash: 'hash-one', head: 'head-two' } }),
    status: 'stale',
    reasonCount: 1,
  },
  {
    facts: facts({ current: { hash: 'hash-two', head: 'head-two' } }),
    status: 'stale',
    reasonCount: 2,
  },
  { facts: facts({ captureErrors: ['git diff failed'] }), status: 'unknown', reasonCount: 1 },
  { facts: facts({ current: undefined }), status: 'unknown', reasonCount: 1 },
  {
    facts: facts({
      current: { hash: 'hash-two', head: 'head-two' },
      captureErrors: ['git diff failed', 'git ls-files failed'],
    }),
    status: 'unknown',
    reasonCount: 2,
  },
] satisfies { facts: FreshnessFacts; status: string; reasonCount: number }[])(
  'decides $status from the recorded and current capture',
  ({ facts: given, status, reasonCount }) => {
    const freshness = decideFreshness(given);

    expect(freshness.status).toBe(status);
    expect(freshness.reasons).toHaveLength(reasonCount);
  },
);

it('passes capture errors through as the reasons for an unknown status', () => {
  const freshness = decideFreshness(facts({ captureErrors: ['git diff failed'] }));

  expect(freshness.reasons).toEqual(['git diff failed']);
});
