import { expect, it } from 'vitest';

import type { PlanStep } from './steps.js';
import { stepStyle } from './stepStyle.js';
import type { StepStyle } from './stepStyle.js';

const table: {
  status: PlanStep['status'];
  expected: StepStyle;
}[] = [
  {
    status: 'pending',
    expected: { mark: '\u{F10C}', markColor: 'muted', textStyle: { fg: 'muted' } },
  },
  {
    status: 'in_progress',
    expected: { mark: '\u{F192}', markColor: 'accent', textStyle: { bold: true } },
  },
  {
    status: 'completed',
    expected: {
      mark: '\u{F058}',
      markColor: 'success',
      textStyle: { fg: 'dim', strikethrough: true },
    },
  },
  {
    status: 'blocked',
    expected: { mark: '\u{F06A}', markColor: 'warning', textStyle: { fg: 'warning' } },
  },
];

it.each(table.map((row) => [row.status, row] as const))('styles the %s step', (_status, row) => {
  expect(stepStyle(row.status)).toEqual(row.expected);
});
