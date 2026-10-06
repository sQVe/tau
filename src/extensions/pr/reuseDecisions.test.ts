import { expect, it } from 'vitest';

import { compareDiffs, decideReuse } from './reuseDecisions.js';
import type { ReuseFacts } from './reuseDecisions.js';

const section = (path: string, ...lines: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...lines, ''].join('\n');

const one = section('one.ts', '@@ -1 +1 @@', '-old', '+new');
const two = section('two.ts', '@@ -1 +1 @@', '-before', '+after');
const three = section('three.ts', '@@ -0,0 +1 @@', '+added');
const deleted = section('one.ts', 'deleted file mode 100644');

const renamed =
  'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';

// A file whose path is literally "a/old.ts b/new.ts" has the paths the rename reports.
const renameLookalike = section('a/old.ts b/new.ts', '@@ -1 +1 @@', '-x', '+y');

const diff = (...sections: string[]) => Buffer.from(sections.join(''));

it.each([
  { reviewed: diff(one, two), current: diff(two, one), result: {} },
  { reviewed: diff(), current: diff(), result: {} },
  { reviewed: diff(renamed), current: diff(renamed), result: {} },
  {
    reviewed: diff(renamed, renameLookalike),
    current: diff(renameLookalike, renamed),
    result: {},
  },
  {
    reviewed: diff(one, two),
    current: diff(one, two.replace('+after', '+changed')),
    result: { differing: ['two.ts'] },
  },
  { reviewed: diff(one, two), current: diff(deleted, two), result: { differing: ['one.ts'] } },
  { reviewed: diff(one), current: diff(one, three), result: { extra: ['three.ts'] } },
  { reviewed: diff(one, three), current: diff(one), result: { missing: ['three.ts'] } },
  {
    reviewed: diff(renamed),
    current: diff(section('new.ts', '@@ -0,0 +1 @@', '+added')),
    result: { missing: ['a/old.ts b/new.ts'], extra: ['new.ts'] },
  },
  {
    reviewed: diff(one, two),
    current: diff(three),
    result: { missing: ['one.ts', 'two.ts'], extra: ['three.ts'] },
  },
])('compares the sections of two diffs by path: $result', ({ reviewed, current, result }) => {
  expect(compareDiffs(reviewed, current)).toEqual({
    differing: [],
    missing: [],
    extra: [],
    ...result,
  });
});

it('compares bytes that are not UTF-8', () => {
  const reviewed = Buffer.concat([Buffer.from(section('one.ts', '+')), Buffer.from([0xff])]);
  const current = Buffer.concat([Buffer.from(section('one.ts', '+')), Buffer.from([0xfe])]);

  expect(compareDiffs(reviewed, current).differing).toEqual(['one.ts']);
});

const sameDiffs = { differing: [], missing: [], extra: [] };

const reuseFacts = (overrides: Partial<ReuseFacts> = {}): ReuseFacts => ({
  recordedHash: 'hash-one',
  recheckHash: 'hash-one',
  recordedBase: 'base-one',
  mergeBase: 'base-one',
  baseIsAncestor: true,
  comparison: sameDiffs,
  ...overrides,
});

it.each([
  { facts: reuseFacts(), status: 'match', reasonCount: 0 },
  { facts: reuseFacts({ mergeBase: 'base-two' }), status: 'match', reasonCount: 0 },
  { facts: reuseFacts({ recheckHash: 'hash-two' }), status: 'mismatch', reasonCount: 1 },
  {
    facts: reuseFacts({ mergeBase: 'base-two', baseIsAncestor: false }),
    status: 'mismatch',
    reasonCount: 1,
  },
  { facts: reuseFacts({ recordedBase: null }), status: 'mismatch', reasonCount: 1 },
  {
    facts: reuseFacts({ comparison: { differing: ['one.ts'], missing: [], extra: [] } }),
    status: 'mismatch',
    reasonCount: 1,
  },
  {
    facts: reuseFacts({ comparison: { differing: [], missing: ['one.ts'], extra: ['two.ts'] } }),
    status: 'mismatch',
    reasonCount: 2,
  },
  {
    facts: reuseFacts({ recheckHash: 'hash-two', baseIsAncestor: false, mergeBase: 'base-two' }),
    status: 'mismatch',
    reasonCount: 2,
  },
])('decides reuse as $status with $reasonCount reasons', ({ facts, status, reasonCount }) => {
  const decision = decideReuse(facts);

  expect(decision.status).toBe(status);
  expect(decision.reasons).toHaveLength(reasonCount);
});
