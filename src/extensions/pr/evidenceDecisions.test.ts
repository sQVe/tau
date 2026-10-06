import { expect, it } from 'vitest';

import { checkLogGaps, matchCheckLog, selectLatestChecks } from './evidenceDecisions.js';
import type { CheckIdentity, CheckLog, ModifiedCheckLog } from './evidenceDecisions.js';

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

it.each([
  {
    name: 'changed head',
    check: matchCheckLog('check.log', log({ ...current, head: 'd'.repeat(40) }), current),
    gap: false,
  },
  {
    name: 'changed status',
    check: matchCheckLog('check.log', log({ ...current, status: 'd'.repeat(64) }), current),
    gap: false,
  },
  {
    name: 'changed diff',
    check: matchCheckLog('check.log', log({ ...current, diff: 'd'.repeat(64) }), current),
    gap: false,
  },
  { name: 'missing header', check: matchCheckLog('check.log', 'passed', current), gap: true },
  {
    name: 'malformed header',
    check: matchCheckLog('check.log', log({ ...current, head: 'broken' }), current),
    gap: true,
  },
  { name: 'unavailable identity', check: matchCheckLog('check.log', log(), null), gap: true },
])('reports a gap only for incomplete evidence: $name', ({ check, gap }) => {
  const expected = gap ? [{ kind: 'check', path: check.path, reasons: check.reasons }] : [];

  expect(checkLogGaps([check])).toEqual(expected);
});

it('reports unreadable logs as gaps', () => {
  const check: CheckLog = {
    path: 'check.log',
    matches: false,
    reasons: [{ field: 'read', reason: 'access denied' }],
    excerpt: null,
    truncated: false,
  };

  expect(checkLogGaps([check])).toEqual([
    { kind: 'check', path: check.path, reasons: check.reasons },
  ]);
});

it('reports the absence of logs', () => {
  expect(checkLogGaps([])).toEqual([{ kind: 'noChecks' }]);
});

const savedLog = (run: string, modifiedAt: number | null, text = log()): ModifiedCheckLog => ({
  name: 'test.log',
  modifiedAt,
  check: matchCheckLog(`${run}/test.log`, text, current),
});

const olderLog = savedLog('run-z', 100, log({ ...current, head: 'd'.repeat(40) }));
const newerLog = savedLog('run-a', 200);
const malformedLog = savedLog('run-b', 300, 'missing header');
const unknownTimeLog = savedLog('run-unknown', null, 'unreadable');

const otherCheck: ModifiedCheckLog = {
  name: 'lint.log',
  modifiedAt: 50,
  check: matchCheckLog('run-other/lint.log', log(), current),
};

it.each([
  { name: 'no logs', logs: [], selected: [] },
  { name: 'one log', logs: [olderLog], selected: [olderLog.check] },
  { name: 'newer matching log', logs: [olderLog, newerLog], selected: [newerLog.check] },
  { name: 'reverse read order', logs: [newerLog, olderLog], selected: [newerLog.check] },
  {
    name: 'different check names',
    logs: [olderLog, otherCheck, newerLog],
    selected: [newerLog.check, otherCheck.check],
  },
  { name: 'newer malformed log', logs: [newerLog, malformedLog], selected: [malformedLog.check] },
  {
    name: 'newer mismatching log',
    logs: [newerLog, { ...olderLog, modifiedAt: 300 }],
    selected: [olderLog.check],
  },
  { name: 'unknown timestamp', logs: [unknownTimeLog, newerLog], selected: [unknownTimeLog.check] },
  {
    name: 'unknown timestamp read last',
    logs: [newerLog, unknownTimeLog],
    selected: [unknownTimeLog.check],
  },
  {
    name: 'equal timestamps',
    logs: [savedLog('run-a', 100), olderLog],
    selected: [olderLog.check],
  },
  {
    name: 'equal timestamps in reverse order',
    logs: [olderLog, savedLog('run-a', 100)],
    selected: [olderLog.check],
  },
])('selects the latest evidence per check name: $name', ({ logs, selected }) => {
  expect(selectLatestChecks(logs)).toEqual(selected);
});
