import { expect, it } from 'vitest';

import { planPromptText, planReportText, planUpdateLine } from './prompt.js';
import type { PlanStep } from './steps.js';
import { planEntryType, planRecord } from './steps.js';

const step = (text: string, status: PlanStep['status'] = 'pending'): PlanStep => ({ text, status });

const savedPlan = (steps: readonly PlanStep[]) => ({
  type: 'custom',
  customType: planEntryType,
  data: planRecord(steps),
});

const promptTable: { name: string; steps: PlanStep[]; expected: string | undefined }[] = [
  { name: 'no steps', steps: [], expected: undefined },
  {
    name: 'every step completed',
    steps: [step('Brief worker', 'completed'), step('Open the PR', 'completed')],
    expected: undefined,
  },
  {
    name: 'a mixed plan',
    steps: [
      step('Brief worker', 'completed'),
      step('Review change', 'in_progress'),
      step('Open the PR'),
    ],
    expected: [
      'Current plan:',
      '[completed] Brief worker',
      '[in_progress] Review change',
      '[pending] Open the PR',
    ].join('\n'),
  },
  {
    name: 'a blocked step beside a pending one',
    steps: [step('Wait for the answer', 'blocked'), step('Open the PR')],
    expected: ['Current plan:', '[blocked] Wait for the answer', '[pending] Open the PR'].join(
      '\n',
    ),
  },
  {
    name: 'step text with a line break',
    steps: [step('Draft\n\nthe  plan')],
    expected: ['Current plan:', '[pending] Draft the  plan'].join('\n'),
  },
];

it.each(promptTable)('builds the prompt block for $name', ({ steps, expected }) => {
  expect(planPromptText(steps)).toBe(expected);
});

const reportTable: { name: string; entries: unknown[]; expected: string }[] = [
  { name: 'no plan entry', entries: [], expected: '' },
  {
    name: 'every step completed',
    entries: [savedPlan([step('Brief worker', 'completed'), step('Open the PR', 'completed')])],
    expected: '',
  },
  {
    name: 'a mixed plan',
    entries: [savedPlan([step('Brief worker', 'completed'), step('Review change', 'in_progress')])],
    expected: [
      '',
      '',
      'Current plan:',
      '[completed] Brief worker',
      '[in_progress] Review change',
      '',
      planUpdateLine,
    ].join('\n'),
  },
  {
    name: 'two plan entries',
    entries: [savedPlan([step('Old step')]), savedPlan([step('New step')])],
    expected: ['', '', 'Current plan:', '[pending] New step', '', planUpdateLine].join('\n'),
  },
  {
    name: 'a malformed entry after a valid plan',
    entries: [
      savedPlan([step('Kept')]),
      { type: 'custom', customType: planEntryType, data: { version: 1, steps: 'not a list' } },
    ],
    expected: ['', '', 'Current plan:', '[pending] Kept', '', planUpdateLine].join('\n'),
  },
];

it.each(reportTable)('builds the report suffix for $name', ({ entries, expected }) => {
  expect(planReportText(entries)).toBe(expected);
});
