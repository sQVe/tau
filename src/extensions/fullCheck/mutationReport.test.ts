import { expect, it } from 'vitest';

import { parseMutationReport } from './mutationReport.js';

const survivor = {
  file: 'a.ts',
  line: 3,
  mutator: 'BooleanLiteral',
  original: 'true',
  replacement: 'false',
  covered: true,
};

const reportWith = (item: Record<string, unknown>) =>
  JSON.stringify({ version: 1, status: 'survivors', survivors: [item] });

const withoutCovered = Object.fromEntries(
  Object.entries(survivor).filter(([key]) => key !== 'covered'),
);

it.each([
  { name: 'covered missing', item: withoutCovered, field: 'covered' },
  { name: 'covered "false"', item: { ...survivor, covered: 'false' }, field: 'covered' },
  { name: 'covered 0', item: { ...survivor, covered: 0 }, field: 'covered' },
  { name: 'line 0', item: { ...survivor, line: 0 }, field: 'line' },
  { name: 'line -1', item: { ...survivor, line: -1 }, field: 'line' },
  { name: 'line 1.5', item: { ...survivor, line: 1.5 }, field: 'line' },
])('rejects a survivor with $name', ({ item, field }) => {
  expect(() => parseMutationReport(reportWith(item))).toThrow(field);
});

it.each([
  { name: 'covered true', item: survivor },
  { name: 'covered false', item: { ...survivor, covered: false } },
  { name: 'line 1', item: { ...survivor, line: 1 } },
])('keeps a valid survivor with $name', ({ item }) => {
  const report = parseMutationReport(reportWith({ ...item, column: 7 }));

  expect(report.survivors).toEqual([item]);
});
