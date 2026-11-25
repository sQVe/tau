import type { PlanStep } from './steps.js';
import { replayPlan, showsPlan } from './steps.js';

export const planUpdateLine = 'Update `plan` if this report finishes or blocks a step.';

const singleLine = (text: string): string => text.replace(/[\r\n\u2028\u2029]+/g, ' ');

export const planPromptText = (steps: readonly PlanStep[]): string | undefined => {
  if (!showsPlan(steps)) {
    return undefined;
  }

  const lines = steps.map((step) => `[${step.status}] ${singleLine(step.text)}`);

  return ['Current plan:', ...lines].join('\n');
};

export const planReportText = (entries: readonly unknown[]): string => {
  const text = planPromptText(replayPlan(entries).steps);

  if (text === undefined) {
    return '';
  }

  return `\n\n${text}\n\n${planUpdateLine}`;
};
