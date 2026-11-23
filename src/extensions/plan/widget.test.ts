import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import type { PlanStep } from './steps.js';
import { planLines } from './widget.js';

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

const steps: PlanStep[] = [
  { text: 'Brief worker for ME-123', status: 'pending' },
  { text: 'Review worker change', status: 'in_progress' },
  { text: 'Open the PR', status: 'completed' },
  { text: 'Wait for the review', status: 'blocked' },
];

it('keeps each line within the width', () => {
  const widths = planLines(steps, 20, theme).map((line) => visibleWidth(line));

  expect(widths).toEqual([20, 20, 15, 20]);
});

it('shows each status mark', () => {
  const marks = planLines(steps, 80, theme).map((line) => line.slice(0, 3));

  expect(marks).toEqual(['[ ]', '[>]', '[x]', '[!]']);
});

it('renders a line break and an escape sequence as one line', () => {
  const lines = planLines([{ text: 'First\nSecond\u001B[31m', status: 'pending' }], 80, theme);

  expect(lines).toEqual(['[ ] First Second']);
});
