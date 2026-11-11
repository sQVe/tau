import { expect, it } from 'vitest';

import type { ToolCall } from './sessionHealthReport.js';
import { healthRules } from './sessionHealthRules.js';

const call = (fields: Partial<ToolCall>): ToolCall => ({
  tool: 'run_tests',
  day: '2026-11-11',
  side: 'manager',
  viaCodemode: false,
  arguments: undefined,
  details: undefined,
  error: undefined,
  ...fields,
});

const times = (count: number, fields: Partial<ToolCall>) =>
  Array.from({ length: count }, () => call(fields));

const fresh = { details: { freshness: 'fresh' } };
const unknown = { details: { freshness: 'unknown' } };
const focused = { arguments: { scope: 'focused' } };
const affected = { arguments: { scope: 'affected' } };

const refusal = {
  error: 'Report refused: the summary has 3,488 characters, over the limit of 3,000.',
};

const check = (name: string, calls: ToolCall[], day = '2026-11-11') => {
  const rule = healthRules.find((candidate) => candidate.name === name);

  if (rule === undefined) {
    throw new Error(`No rule ${name}`);
  }

  return rule.check(calls, day);
};

it.each([
  { name: 'no calls', rule: 'freshness-known', calls: [], fails: false },
  { name: 'two unknown', rule: 'freshness-known', calls: times(2, unknown), fails: false },
  { name: 'three unknown', rule: 'freshness-known', calls: times(3, unknown), fails: true },
  {
    name: 'half unknown',
    rule: 'freshness-known',
    calls: [...times(2, unknown), ...times(2, fresh)],
    fails: false,
  },
  {
    name: 'most unknown',
    rule: 'freshness-known',
    calls: [...times(3, unknown), ...times(2, fresh)],
    fails: true,
  },
  {
    name: 'unknown and missing freshness',
    rule: 'freshness-known',
    calls: [...times(3, unknown), ...times(3, {})],
    fails: true,
  },
  {
    name: 'twenty focused runs',
    rule: 'affected-scope-used',
    calls: times(20, focused),
    fails: true,
  },
  {
    name: 'nineteen focused runs',
    rule: 'affected-scope-used',
    calls: times(19, focused),
    fails: false,
  },
  {
    name: 'an affected run',
    rule: 'affected-scope-used',
    calls: [...times(20, focused), call(affected)],
    fails: false,
  },
  {
    name: 'a day before the affected scope',
    rule: 'affected-scope-used',
    calls: times(20, focused),
    day: '2026-11-10',
    fails: false,
  },
  { name: 'no reports', rule: 'summary-length-accepted', calls: [], fails: false },
  {
    name: 'another error',
    rule: 'summary-length-accepted',
    calls: [call({ error: 'other' })],
    fails: false,
  },
  {
    name: 'a length refusal',
    rule: 'summary-length-accepted',
    calls: [call({}), call(refusal)],
    fails: true,
  },
])('$rule with $name fails: $fails', ({ rule, calls, day, fails }) => {
  expect(check(rule, calls, day) !== undefined).toBe(fails);
});
