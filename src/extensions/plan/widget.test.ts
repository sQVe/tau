import { stripVTControlCharacters } from 'node:util';

import type { Theme, ThemeColor, ThemeStyle } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import type { PlanStep } from './steps.js';
import { planLabelColumn, planLines } from './widget.js';

const theme = {
  fg: (_color: ThemeColor, text: string) => text,
  style: (text: string, _options: ThemeStyle) => text,
} satisfies Pick<Theme, 'fg' | 'style'>;

const columnOf = (line: string, text: string): number => {
  const index = line.indexOf(text);

  if (index === -1) {
    throw new Error(`The line does not hold ${text}.`);
  }

  return visibleWidth(line.slice(0, index));
};

const codes = {
  border: '90',
  muted: '2',
  accent: '36',
  dim: '35',
  warning: '33',
  success: '32',
} as const;

const isStyledColor = (color: unknown): color is keyof typeof codes =>
  typeof color === 'string' && Object.hasOwn(codes, color);

const styled = (color: ThemeColor, text: string) => {
  if (!isStyledColor(color)) {
    throw new Error(`The test theme does not style the ${color} color.`);
  }

  return `\u001B[${codes[color]}m${text}\u001B[0m`;
};

const supportedStyleFields: ReadonlySet<string> = new Set(['fg', 'bold', 'strikethrough']);

const isSetStyleField = (value: unknown): boolean => value !== undefined && value !== false;

const rejectUnsupportedStyleField = (options: ThemeStyle): void => {
  const suppliedFields = Object.entries(options as Record<string, unknown>);

  for (const [field, value] of suppliedFields) {
    if (isSetStyleField(value) && !supportedStyleFields.has(field)) {
      throw new Error(`The recording theme does not style the ${field} field.`);
    }
  }
};

const styleCode = (options: ThemeStyle): string => {
  rejectUnsupportedStyleField(options);

  const parts: string[] = [];
  const color = options.fg;

  if (color !== undefined) {
    if (!isStyledColor(color)) {
      throw new Error(`The test theme does not style the ${JSON.stringify(color)} color.`);
    }

    parts.push(codes[color]);
  }

  if (options.bold === true) {
    parts.push('1');
  }

  if (options.strikethrough === true) {
    parts.push('9');
  }

  return parts.join(';');
};

const styledText = (text: string, options: ThemeStyle) =>
  `\u001B[${styleCode(options)}m${text}\u001B[0m`;

const styledTheme = {
  fg: (color: ThemeColor, text: string) => styled(color, text),
  style: (text: string, options: ThemeStyle) => styledText(text, options),
} satisfies Pick<Theme, 'fg' | 'style'>;

const steps: PlanStep[] = [
  { text: 'Brief worker for ME-123', status: 'pending' },
  { text: 'Review worker change', status: 'in_progress' },
  { text: 'Open the PR', status: 'completed' },
  { text: 'Wait for the review', status: 'blocked' },
];

const fiveSteps: PlanStep[] = [
  { text: 'Brief the worker', status: 'completed' },
  { text: 'Review its change', status: 'completed' },
  { text: 'Commit the slice', status: 'in_progress' },
  { text: 'Open the PR', status: 'pending' },
  { text: 'Fix the lint warning', status: 'blocked' },
];

const labelEnd = planLabelColumn + visibleWidth('Plan');
const counterEnd = labelEnd + visibleWidth(' · 2/5');

it('shows the completed count in the header', () => {
  const [header] = planLines(fiveSteps, 80, theme);

  expect(header).toBe(`─── Plan · 2/5 ${'─'.repeat(65)}`);
  expect(visibleWidth(header ?? '')).toBe(80);
});

it('colors the header border, label, and counter', () => {
  const [header] = planLines(fiveSteps, 80, styledTheme);

  expect(header).toBe(
    `${styled('border', '─── ')}${styled('muted', 'Plan')}${styled('muted', ' · 2/5')} ${styled('border', '─'.repeat(65))}`,
  );
});

it.each([14, 80])('starts the label and step text in the same column at width %i', (width) => {
  const lines = planLines([{ text: 'Brief worker', status: 'pending' }], width, theme);

  expect(columnOf(lines[0] ?? '', 'Plan')).toBe(planLabelColumn);
  expect(columnOf(lines[1] ?? '', 'Brief')).toBe(planLabelColumn);
});

it.each([
  [1, '─'],
  [2, '──'],
  [3, '───'],
  [4, '─── '],
  [5, '─── P'],
  [6, '─── Pl'],
  [7, '─── Pla'],
  [8, '─── Plan'],
])('cuts the header to width %i', (width, expected) => {
  const [header] = planLines(fiveSteps, width, theme);

  expect(stripVTControlCharacters(header ?? '')).toBe(expected);
});

it.each([
  [16, '─── Plan · 2/5 ─'],
  [15, '─── Plan · 2/5 '],
  [14, '─── Plan · 2/5'],
  [13, '─── Plan'],
])('drops the header rule and then the counter at width %i', (width, expected) => {
  const [header] = planLines(fiveSteps, width, theme);

  expect(stripVTControlCharacters(header ?? '')).toBe(expected);
});

const headerWidthAt = (width: number): number => {
  if (width < labelEnd) {
    return width;
  }

  if (width < counterEnd) {
    return labelEnd;
  }

  return width;
};

it('fills the width with the header while it fits', () => {
  const widths = Array.from({ length: 40 }, (_value, index) => index + 1);

  const drawn = widths.map((width) => visibleWidth(planLines(fiveSteps, width, theme)[0] ?? ''));

  expect(drawn).toEqual(widths.map(headerWidthAt));
});

it.each([
  [1, '\u{F10C}'],
  [2, ' \u{F10C}'],
  [3, ' \u{F10C}'],
  [4, ' \u{F10C}  '],
  [5, ' \u{F10C}  …'],
  [12, ' \u{F10C}  Brief w…'],
])('keeps the status mark and gap at width %i', (width, expected) => {
  const line = planLines([{ text: 'Brief worker', status: 'pending' }], width, theme)[1] ?? '';

  expect(stripVTControlCharacters(line)).toBe(expected);
  expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

it.each([
  [5, '…'],
  [6, 'O…'],
  [7, 'Op…'],
])('clips a completed step text with an ellipsis at width %i', (width, expected) => {
  const lines = planLines([{ text: 'Open the PR', status: 'completed' }], width, styledTheme);

  expect(lines[1]).toBe(
    ` ${styled('success', '\u{F058}')}  ${styledText(expected, { fg: 'dim', strikethrough: true })}`,
  );
});

it('shows a Nerd Font mark for each status', () => {
  const marks = planLines(steps, 80, theme)
    .slice(1)
    .map((line) => line.slice(1, 2));

  expect(marks).toEqual(['\u{F10C}', '\u{F192}', '\u{F058}', '\u{F06A}']);
});

it('styles each status mark and step text', () => {
  const [, ...stepLines] = planLines(fiveSteps, 80, styledTheme);

  expect(stepLines).toEqual([
    ` ${styled('success', '\u{F058}')}  ${styledText('Brief the worker', { fg: 'dim', strikethrough: true })}`,
    ` ${styled('success', '\u{F058}')}  ${styledText('Review its change', { fg: 'dim', strikethrough: true })}`,
    ` ${styled('accent', '\u{F192}')}  ${styledText('Commit the slice', { bold: true })}`,
    ` ${styled('muted', '\u{F10C}')}  ${styledText('Open the PR', { fg: 'muted' })}`,
    ` ${styled('warning', '\u{F06A}')}  ${styledText('Fix the lint warning', { fg: 'warning' })}`,
  ]);
});

it('rejects a style field the recording theme does not draw', () => {
  const unsupportedStyles = [
    { field: 'bg', options: { bg: 'selectedBg' } },
    { field: 'dim', options: { dim: true } },
    { field: 'italic', options: { italic: true } },
    { field: 'underline', options: { underline: true } },
    { field: 'inverse', options: { inverse: true } },
    { field: 'blink', options: { blink: true } as unknown as ThemeStyle },
  ] satisfies { field: string; options: ThemeStyle }[];

  for (const { field, options } of unsupportedStyles) {
    expect(() => styleCode(options)).toThrow(field);
  }
});

it('keeps the step text aligned when a mark draws narrower', () => {
  const narrowMarkTheme = {
    fg: (_color: ThemeColor, text: string) => (text === '\u{F192}' ? '' : text),
    style: (text: string, _options: ThemeStyle) => text,
  } satisfies Pick<Theme, 'fg' | 'style'>;

  const [header, ...stepLines] = planLines(steps, 80, narrowMarkTheme);
  const textColumns = steps.map(({ text }, index) => columnOf(stepLines[index] ?? '', text));

  expect(columnOf(header ?? '', 'Plan')).toBe(planLabelColumn);
  expect(textColumns).toEqual([4, 4, 4, 4]);
});

it('keeps each line within the width', () => {
  const widths = planLines(steps, 20, theme).map((line) => visibleWidth(line));

  expect(widths).toEqual([20, 20, 20, 15, 20]);
});

it('renders a line break and an escape sequence as one line', () => {
  const lines = planLines([{ text: 'First\nSecond\u001B[31m', status: 'pending' }], 80, theme);

  expect(lines.slice(1)).toEqual([' \u{F10C}  First Second']);
});
