import { stripVTControlCharacters } from 'node:util';

import type { ExtensionContext, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';

import { sanitizeSingleLine } from '../../terminalText.js';
import type { PlanStep } from './steps.js';
import { showsPlan } from './steps.js';

export const planWidgetKey = 'tau-plan';

const statusMarks = {
  pending: { mark: '\u{F10C}', color: 'muted' },
  in_progress: { mark: '\u{F192}', color: 'accent' },
  completed: { mark: '\u{F058}', color: 'dim' },
  blocked: { mark: '\u{F06A}', color: 'warning' },
} satisfies Record<PlanStep['status'], { mark: string; color: ThemeColor }>;

const planLabel = 'Plan';

const markWidths = Object.values(statusMarks).map(({ mark }) => visibleWidth(mark));
const markWidth = Math.max(...markWidths);
const stepPrefixWidth = markWidth + 1;

const borderLine = (width: number, theme: Pick<Theme, 'fg'>): string => {
  const labelEnd = stepPrefixWidth + visibleWidth(planLabel) + 1;
  const ruleWidth = Math.max(0, width - labelEnd);
  const head = `${theme.fg('border', '─')}${' '.repeat(stepPrefixWidth - 1)}`;
  const line = `${head}${theme.fg('muted', planLabel)} ${theme.fg('border', '─'.repeat(ruleWidth))}`;

  return truncateToWidth(line, width, '');
};

const planLine = (step: PlanStep, width: number, theme: Theme): string => {
  const { mark, color } = statusMarks[step.status];
  const text = sanitizeSingleLine(step.text);
  const drawnMark = theme.fg(color, mark);
  const textWidth = Math.max(0, width - stepPrefixWidth);
  const fittedText = stripVTControlCharacters(truncateToWidth(text, textWidth));
  const drawnText = step.status === 'completed' ? theme.fg('dim', fittedText) : fittedText;

  return truncateToWidth(`${drawnMark} ${drawnText}`, width, '');
};

export const planLines = (steps: readonly PlanStep[], width: number, theme: Theme): string[] => [
  borderLine(width, theme),
  ...steps.map((step) => planLine(step, width, theme)),
];

const planBox = (steps: readonly PlanStep[], theme: Theme): Component => ({
  render: (width) => planLines(steps, width, theme),
  invalidate() {
    // No render cache: each render draws the list at the current width.
  },
});

export const drawPlan = (context: ExtensionContext, steps: readonly PlanStep[]): void => {
  if (context.mode !== 'tui') {
    return;
  }

  if (!showsPlan(steps)) {
    context.ui.setWidget(planWidgetKey, undefined);

    return;
  }

  context.ui.setWidget(planWidgetKey, (_terminalUI, theme) => planBox(steps, theme));
};
