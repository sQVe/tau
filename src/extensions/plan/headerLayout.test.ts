import { expect, it } from 'vitest';

import type { HeaderLayout } from './headerLayout.js';
import { headerLayout } from './headerLayout.js';

const labelWidth = 8;
const counterWidth = 6;

const table: { width: number; expected: HeaderLayout }[] = [
  { width: 80, expected: { kind: 'withCounter', ruleWidth: 65 } },
  { width: 16, expected: { kind: 'withCounter', ruleWidth: 1 } },
  { width: 15, expected: { kind: 'withCounter', ruleWidth: 0 } },
  { width: 14, expected: { kind: 'withCounter', ruleWidth: 0 } },
  { width: 13, expected: { kind: 'labelOnly' } },
  { width: 1, expected: { kind: 'labelOnly' } },
];

it.each(table.map((row) => [row.width, row] as const))(
  'lays out the header at width %i',
  (_width, row) => {
    expect(headerLayout(row.width, labelWidth, counterWidth)).toEqual(row.expected);
  },
);
