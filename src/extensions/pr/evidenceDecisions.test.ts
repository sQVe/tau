import { expect, it } from 'vitest';

import { checkLogGaps, matchCheckLog } from './evidenceDecisions.js';
import type { CheckIdentity } from './evidenceDecisions.js';

const current: CheckIdentity = {
  head: 'a'.repeat(40),
  status: 'b'.repeat(64),
  diff: 'c'.repeat(64),
};

const log = (identity = current, body = 'passed\n') =>
  `HEAD: ${identity.head}\nStatus: ${identity.status}\nDiff: ${identity.diff}\n${body}`;

it.each([
  { name: 'matching identity', text: log(), identity: current, fields: [] },
  {
    name: 'changed head',
    text: log({ ...current, head: 'd'.repeat(40) }),
    identity: current,
    fields: ['head'],
  },
  {
    name: 'changed status',
    text: log({ ...current, status: 'd'.repeat(64) }),
    identity: current,
    fields: ['status'],
  },
  {
    name: 'changed diff',
    text: log({ ...current, diff: 'd'.repeat(64) }),
    identity: current,
    fields: ['diff'],
  },
  {
    name: 'all changed',
    text: log({ head: 'd'.repeat(40), status: 'd'.repeat(64), diff: 'd'.repeat(64) }),
    identity: current,
    fields: ['head', 'status', 'diff'],
  },
  { name: 'missing header', text: 'passed\n', identity: current, fields: ['header'] },
  {
    name: 'incomplete header',
    text: `HEAD: ${current.head}\n`,
    identity: current,
    fields: ['header'],
  },
  {
    name: 'invalid hash',
    text: log({ ...current, status: 'not-a-hash' }),
    identity: current,
    fields: ['header'],
  },
  {
    name: 'reordered header',
    text: `Status: ${current.status}\nHEAD: ${current.head}\nDiff: ${current.diff}\n`,
    identity: current,
    fields: ['header'],
  },
  { name: 'unavailable current values', text: log(), identity: null, fields: ['current'] },
  {
    name: 'missing header and current values',
    text: '',
    identity: null,
    fields: ['header', 'current'],
  },
])('matches a check log with $name', ({ text, identity, fields }) => {
  const check = matchCheckLog('check.log', text, identity);

  expect(check.matches).toBe(fields.length === 0);
  expect(check.reasons.map((reason) => reason.field)).toEqual(fields);
  expect(check.excerpt).toBe(fields.length === 0 ? 'passed' : null);
});

it.each([
  { name: 'short output', body: 'ok\n', excerpt: 'ok', truncated: false },
  { name: 'empty output', body: '', excerpt: '', truncated: false },
  {
    name: 'too many lines',
    body: `${Array.from({ length: 25 }, (_, index) => index).join('\n')}\n`,
    excerpt: Array.from({ length: 20 }, (_, index) => index + 5).join('\n'),
    truncated: true,
  },
  {
    name: 'one long line',
    body: `${'a'.repeat(5000)}end\n`,
    excerpt: `${'a'.repeat(3997)}end`,
    truncated: true,
  },
])('bounds the last lines of $name', ({ body, excerpt, truncated }) => {
  const check = matchCheckLog('check.log', log(current, body), current);

  expect(check).toMatchObject({ matches: true, excerpt, truncated });

  expect(checkLogGaps([check])).toEqual(
    truncated ? [{ kind: 'checkExcerpt', path: 'check.log' }] : [],
  );
});

it('reports every nonmatching log and the absence of logs', () => {
  const checks = [
    matchCheckLog('old.log', log({ ...current, head: 'd'.repeat(40) }), current),
    matchCheckLog('missing-header.log', 'passed', current),
  ];

  expect(checkLogGaps(checks)).toEqual(
    checks.map((check) => ({ kind: 'check', path: check.path, reasons: check.reasons })),
  );

  expect(checkLogGaps([])).toEqual([{ kind: 'noChecks' }]);
});
