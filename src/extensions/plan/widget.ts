import type { ExtensionContext, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';

import { sanitizeSingleLine } from '../../terminalText.js';
import type { PlanStep } from './steps.js';
import { showsPlan } from './steps.js';

export const planWidgetKey = 'tau-plan';

const statusMarks = {
  pending: { mark: '[ ]', color: 'muted' },
  in_progress: { mark: '[>]', color: 'accent' },
  completed: { mark: '[x]', color: 'success' },
  blocked: { mark: '[!]', color: 'warning' },
} satisfies Record<PlanStep['status'], { mark: string; color: ThemeColor }>;

const planLine = (step: PlanStep, width: number, theme: Theme): string => {
  const { mark, color } = statusMarks[step.status];
  const text = sanitizeSingleLine(step.text);

  return truncateToWidth(`${theme.fg(color, mark)} ${text}`, width);
};

export const planLines = (steps: readonly PlanStep[], width: number, theme: Theme): string[] =>
  steps.map((step) => planLine(step, width, theme));

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
