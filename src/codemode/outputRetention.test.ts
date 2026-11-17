import { expect, it } from 'vitest';

import type { TemporaryOutputFacts } from './outputRetention.js';
import { shouldRemoveTemporaryOutput } from './outputRetention.js';

const retentionMilliseconds = 86_400_000;
const now = 10 * retentionMilliseconds;

const baseFacts: TemporaryOutputFacts = {
  matchesPrefix: true,
  isDirectory: true,
  ownerId: 1000,
  currentUserId: 1000,
  modifiedAt: 0,
  now,
  retentionMilliseconds,
};

const cases: [name: string, overrides: Partial<TemporaryOutputFacts>, expected: boolean][] = [
  ['an old matching directory of the current user', {}, true],
  [
    'a matching directory at the retention boundary',
    { modifiedAt: now - retentionMilliseconds },
    false,
  ],
  [
    'a matching directory older than the retention period',
    { modifiedAt: now - retentionMilliseconds - 1 },
    true,
  ],
  ['a directory for another prefix', { matchesPrefix: false }, false],
  ['a file instead of a directory', { isDirectory: false }, false],
  ['a matching directory of another user', { ownerId: 1001 }, false],
  [
    'a matching directory when the platform has no user id',
    { ownerId: undefined, currentUserId: undefined },
    true,
  ],
];

it.for(cases)('decides removal for %s', ([, overrides, expected]) => {
  expect(shouldRemoveTemporaryOutput({ ...baseFacts, ...overrides })).toBe(expected);
});
