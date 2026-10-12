import { expect, it } from 'vitest';

import { groupHasRunningMember } from './groupMembers.js';

it.each([
  { name: 'a running member', output: ' 100 S\n 200 Ss\n', expected: true },
  { name: 'a running member beside a zombie', output: ' 200 Z\n 200 R+\n', expected: true },
  { name: 'only zombies', output: ' 200 Z\n 200 Z+\n 100 S\n', expected: false },
  { name: 'no rows', output: '', expected: false },
  { name: 'only other groups', output: ' 100 S\n 300 R\n', expected: false },
  { name: 'a group id that only prefixes another', output: ' 2000 S\n', expected: false },
  { name: 'rows with blank lines', output: '\n  200   S  \n\n', expected: true },
])('decides $expected for $name', ({ output, expected }) => {
  expect(groupHasRunningMember(output, 200)).toBe(expected);
});
