import { stripVTControlCharacters } from 'node:util';

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';

import { sanitizeSingleLine } from '../../terminalText.js';
import { headerLayout } from './headerLayout.js';
import type { PlanStep } from './steps.js';
import { showsPlan } from './steps.js';
import { stepStyle, stepStyles } from './stepStyle.js';

type PlanTheme = Pick<Theme, 'fg' | 'style'>;

export const planWidgetKey = 'tau-plan';

const planLabel = 'Plan';
const markIndent = ' ';
const markGap = '  ';

const markWidths = Object.values(stepStyles).map(({ mark }) => visibleWidth(mark));
const markWidth = Math.max(...markWidths);
const markIndentWidth = visibleWidth(markIndent);

const stepPrefixWidth = markIndentWidth + markWidth + visibleWidth(markGap);
const labelPrefix = `${'─'.repeat(stepPrefixWidth - 1)} `;

export const planLabelColumn = stepPrefixWidth;

const headerLine = (steps: readonly PlanStep[], width: number, theme: PlanTheme): string => {
  const completed = steps.filter((step) => step.status === 'completed').length;
  const counterPart = ` · ${completed}/${steps.length}`;
  const labelWidth = visibleWidth(labelPrefix) + visibleWidth(planLabel);
  const layout = headerLayout(width, labelWidth, visibleWidth(counterPart));

  if (layout.kind === 'labelOnly') {
    const labelOnly = `${theme.fg('border', labelPrefix)}${theme.fg('muted', planLabel)}`;

    return truncateToWidth(labelOnly, width, '');
  }

  const rule = theme.fg('border', '─'.repeat(layout.ruleWidth));
  const line = `${theme.fg('border', labelPrefix)}${theme.fg('muted', planLabel)}${theme.fg('muted', counterPart)} ${rule}`;

  return truncateToWidth(line, width, '');
};

const drawMark = (status: PlanStep['status'], theme: PlanTheme): string => {
  const { mark, markColor } = stepStyle(status);
  const drawnMark = theme.fg(markColor, mark);
  const padding = Math.max(0, markWidth - visibleWidth(drawnMark));

  return `${drawnMark}${' '.repeat(padding)}`;
};

const markPrefix = (status: PlanStep['status'], width: number, theme: PlanTheme): string => {
  const drawnMark = drawMark(status, theme);

  if (width < markIndentWidth + markWidth) {
    return drawnMark;
  }

  const gap = width >= stepPrefixWidth ? markGap : '';

  return `${markIndent}${drawnMark}${gap}`;
};

const planLine = (step: PlanStep, width: number, theme: PlanTheme): string => {
  const text = sanitizeSingleLine(step.text);
  const textWidth = Math.max(0, width - planLabelColumn);
  const fittedText = stripVTControlCharacters(truncateToWidth(text, textWidth, '…'));
  const drawnText = theme.style(fittedText, stepStyle(step.status).textStyle);
  const prefix = markPrefix(step.status, width, theme);

  return truncateToWidth(`${prefix}${drawnText}`, width, '');
};

export const planLines = (
  steps: readonly PlanStep[],
  width: number,
  theme: PlanTheme,
): string[] => [
  headerLine(steps, width, theme),
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
