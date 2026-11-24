import { stripVTControlCharacters } from 'node:util';

import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import type { PlanStep } from './steps.js';
import { planLines } from './widget.js';

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

const borderLine = (width: number): string => `─ Plan ${'─'.repeat(width - 7)}`;

const steps: PlanStep[] = [
  { text: 'Brief worker for ME-123', status: 'pending' },
  { text: 'Review worker change', status: 'in_progress' },
  { text: 'Open the PR', status: 'completed' },
  { text: 'Wait for the review', status: 'blocked' },
];

it('draws a labeled border above the steps', () => {
  const [border] = planLines(steps, 80, theme);

  expect(border).toBe(`─ Plan ${'─'.repeat(73)}`);
  expect(visibleWidth(border ?? '')).toBe(80);
});

it('starts the label above the step text', () => {
  const lines = planLines([{ text: 'Brief worker', status: 'pending' }], 80, theme);

  expect(lines[0]?.indexOf('Plan')).toBe(2);
  expect(lines[1]?.indexOf('Brief')).toBe(2);
});

it.each([
  [1, '─'],
  [2, '─ '],
  [3, '─ P'],
  [6, '─ Plan'],
])('cuts the border line to width %i', (width, expected) => {
  const [border] = planLines(steps, width, theme);

  expect(stripVTControlCharacters(border ?? '')).toBe(expected);
});

it.each([
  [1, '\u{F10C}'],
  [2, '\u{F10C} '],
  [3, '\u{F10C} .'],
])('keeps the status mark at width %i', (width, expected) => {
  const line = planLines([{ text: 'Brief worker', status: 'pending' }], width, theme)[1] ?? '';

  expect(stripVTControlCharacters(line)).toBe(expected);
  expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

it('keeps each line within the width', () => {
  const widths = planLines(steps, 20, theme).map((line) => visibleWidth(line));

  expect(widths).toEqual([20, 20, 20, 13, 20]);
});

it('shows a Nerd Font mark for each status', () => {
  const marks = planLines(steps, 80, theme)
    .slice(1)
    .map((line) => line.slice(0, 1));

  expect(marks).toEqual(['\u{F10C}', '\u{F192}', '\u{F058}', '\u{F06A}']);
});

it('colors each mark and dims a completed step', () => {
  const codes = { border: '90', muted: '2', accent: '36', dim: '35', warning: '33' } as const;

  const styled = (color: keyof typeof codes, text: string) =>
    `\u001B[${codes[color]}m${text}\u001B[0m`;

  const styledTheme = {
    fg: (color: keyof typeof codes, text: string) => styled(color, text),
  } as unknown as Theme;

  const lines = planLines(steps, 80, styledTheme);

  expect(lines).toEqual([
    `${styled('border', '─')} ${styled('muted', 'Plan')} ${styled('border', '─'.repeat(73))}`,
    `${styled('muted', '\u{F10C}')} Brief worker for ME-123`,
    `${styled('accent', '\u{F192}')} Review worker change`,
    `${styled('dim', '\u{F058}')} ${styled('dim', 'Open the PR')}`,
    `${styled('warning', '\u{F06A}')} Wait for the review`,
  ]);
});

it('renders a line break and an escape sequence as one line', () => {
  const lines = planLines([{ text: 'First\nSecond\u001B[31m', status: 'pending' }], 80, theme);

  expect(lines).toEqual([borderLine(80), '\u{F10C} First Second']);
});
