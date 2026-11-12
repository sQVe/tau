import { expect, it } from 'vitest';

import { hasWorkerReports } from './reports.js';

it.each([
  { name: 'a reviewer report', names: ['reviewer.md'], expected: true },
  { name: 'a finder and a checker report', names: ['finder.md', 'checker.md'], expected: true },
  { name: 'only a finder report', names: ['finder.md'], expected: false },
  { name: 'only a checker report', names: ['checker.md'], expected: false },
  { name: 'no report', names: [], expected: false },
])('reads $name as worker reports: $expected', ({ names, expected }) => {
  expect(hasWorkerReports(names)).toBe(expected);
});
