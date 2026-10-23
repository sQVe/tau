import { expect, it } from 'vitest';

import { groupHasRunningMember, groupStateFromTable, stateFromProbe } from './stateDecision.js';

it.each([
  { name: 'a running member', output: ' 100 S\n 200 Ss\n', expected: true },
  { name: 'a running member beside a zombie', output: ' 200 Z\n 200 R+\n', expected: true },
  { name: 'only zombies', output: ' 200 Z\n 200 Z+\n 100 S\n', expected: false },
  { name: 'no rows', output: '', expected: false },
  { name: 'only other groups', output: ' 100 S\n 300 R\n', expected: false },
  { name: 'a group id that only prefixes another', output: ' 2000 S\n', expected: false },
  { name: 'rows with blank lines', output: '\n  200   S  \n\n', expected: true },
  { name: 'a zombie after several spaces', output: '  200      Z\n', expected: false },
  { name: 'a row with no state column', output: '  200\n', expected: false },
])('decides $expected for $name', ({ output, expected }) => {
  expect(groupHasRunningMember(output, 200)).toBe(expected);
});

it.each([
  { name: 'a successful probe', code: undefined, expected: 'running' },
  { name: 'EPERM', code: 'EPERM', expected: 'running' },
  { name: 'ESRCH', code: 'ESRCH', expected: 'gone' },
  { name: 'another error', code: 'EINVAL', expected: 'unknown' },
])('maps $name to $expected', ({ code, expected }) => {
  expect(stateFromProbe(code)).toBe(expected);
});

it.each([
  { name: 'a running member', output: ' 200 S\n', expected: 'running' },
  { name: 'only zombies', output: ' 200 Z\n', expected: 'gone' },
  { name: 'no member', output: ' 100 S\n', expected: 'gone' },
  { name: 'a failed read', output: undefined, expected: 'unknown' },
])('reads the process table with $name as $expected', ({ output, expected }) => {
  expect(groupStateFromTable(output, 200)).toBe(expected);
});
