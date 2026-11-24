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
const labelPrefix = '── ';
const markIndent = ' ';

const markWidths = Object.values(statusMarks).map(({ mark }) => visibleWidth(mark));
const markWidth = Math.max(...markWidths);

export const planLabelColumn = visibleWidth(labelPrefix);

const borderLine = (width: number, theme: Pick<Theme, 'fg'>): string => {
  const labelWidth = visibleWidth(planLabel);
  const ruleWidth = Math.max(0, width - visibleWidth(labelPrefix) - labelWidth - 1);
  const line = `${theme.fg('border', labelPrefix)}${theme.fg('muted', planLabel)} ${theme.fg('border', '─'.repeat(ruleWidth))}`;

  return truncateToWidth(line, width, '');
};

const drawMark = (status: PlanStep['status'], theme: Pick<Theme, 'fg'>): string => {
  const { mark, color } = statusMarks[status];
  const drawnMark = theme.fg(color, mark);
  const padding = Math.max(0, markWidth - visibleWidth(drawnMark));

  return `${drawnMark}${' '.repeat(padding)}`;
};

const markPrefix = (
  status: PlanStep['status'],
  width: number,
  theme: Pick<Theme, 'fg'>,
): string => {
  const drawnMark = drawMark(status, theme);

  if (width <= markWidth) {
    return drawnMark;
  }

  const markGap = ' '.repeat(Math.max(0, planLabelColumn - visibleWidth(markIndent) - markWidth));

  return `${markIndent}${drawnMark}${markGap}`;
};

const planLine = (step: PlanStep, width: number, theme: Pick<Theme, 'fg'>): string => {
  const text = sanitizeSingleLine(step.text);
  const textWidth = Math.max(0, width - planLabelColumn);
  const fittedText = stripVTControlCharacters(truncateToWidth(text, textWidth));
  const drawnText = step.status === 'completed' ? theme.fg('dim', fittedText) : fittedText;
  const prefix = markPrefix(step.status, width, theme);

  return truncateToWidth(`${prefix}${drawnText}`, width, '');
};

export const planLines = (
  steps: readonly PlanStep[],
  width: number,
  theme: Pick<Theme, 'fg'>,
): string[] => [borderLine(width, theme), ...steps.map((step) => planLine(step, width, theme))];

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
