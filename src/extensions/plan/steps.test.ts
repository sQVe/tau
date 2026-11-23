import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import {
  checkSteps,
  maxPlanSteps,
  planEntryType,
  planRecordSchema,
  planSummary,
  replayPlan,
  showsPlan,
} from './steps.js';
import type { PlanStep } from './steps.js';

type ExpectedCheck = { kind: 'accepted' } | { kind: 'refused'; reason: RegExp };

type Unreadable = { kind: 'newer'; version: number } | { kind: 'malformed' };

const step = (text: string, status: PlanStep['status'] = 'pending'): PlanStep => ({ text, status });

const stepsOf = (count: number): PlanStep[] =>
  Array.from({ length: count }, (_unused, index) => step(`Step ${index + 1}`));

const saved = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'planRecord', name), 'utf8'),
  ) as unknown;

const entry = (customType: string, data: unknown) => ({ type: 'custom', customType, data });

const currentSteps = [step('Review worker change for ME-123', 'in_progress'), step('Open the PR')];

const checkCases: { name: string; steps: readonly PlanStep[]; expected: ExpectedCheck }[] = [
  {
    name: 'refuses 13 steps',
    steps: stepsOf(maxPlanSteps + 1),
    expected: { kind: 'refused', reason: /12/ },
  },
  {
    name: 'accepts three steps with one in_progress',
    steps: [
      step('Brief worker for ME-123', 'in_progress'),
      step('Review worker change for ME-123'),
      step('Open the PR'),
    ],
    expected: { kind: 'accepted' },
  },
  { name: 'accepts an empty list', steps: [], expected: { kind: 'accepted' } },
  {
    name: 'accepts the step cap',
    steps: stepsOf(maxPlanSteps),
    expected: { kind: 'accepted' },
  },
  {
    name: 'accepts a ticket identifier as step text',
    steps: [step('ME-123')],
    expected: { kind: 'accepted' },
  },
  {
    name: 'refuses two steps in_progress',
    steps: [step('Brief worker', 'in_progress'), step('Review change', 'in_progress')],
    expected: { kind: 'refused', reason: /in_progress/ },
  },
  {
    name: 'refuses an empty text at step 2',
    steps: [step('Brief worker'), step('  '), step('Open the PR')],
    expected: { kind: 'refused', reason: /Step 2/ },
  },
  {
    name: 'reports the step cap before an empty text',
    steps: stepsOf(maxPlanSteps + 1).map((value, index) => (index === 2 ? step('  ') : value)),
    expected: { kind: 'refused', reason: /12/ },
  },
];

it.each(checkCases.map((row) => [row.name, row] as const))('%s', (_name, { steps, expected }) => {
  const result = checkSteps(steps);

  const outcome =
    result.kind === 'refused'
      ? { kind: result.kind, reason: result.reason }
      : { kind: result.kind };

  expect(outcome).toMatchObject(expected);
});

it.each([
  ['current.json', true],
  ['newer.json', false],
  ['malformed.json', false],
] as const)('checks the saved %s fixture against the record schema', (name, expected) => {
  expect(Value.Check(planRecordSchema, saved(name))).toBe(expected);
});

const replayCases: {
  name: string;
  entries: readonly unknown[];
  expected: { steps: readonly PlanStep[]; unreadable: Unreadable[] };
}[] = [
  {
    name: 'gives an empty plan without entries',
    entries: [],
    expected: { steps: [], unreadable: [] },
  },
  {
    name: 'takes the second of two valid plans',
    entries: [
      entry(planEntryType, { version: 1, steps: [step('First')] }),
      entry(planEntryType, { version: 1, steps: [step('Second')] }),
    ],
    expected: { steps: [step('Second')], unreadable: [] },
  },
  {
    name: 'reads the current saved record',
    entries: [entry(planEntryType, saved('current.json'))],
    expected: { steps: currentSteps, unreadable: [] },
  },
  {
    name: 'keeps a valid plan when a newer record follows',
    entries: [
      entry(planEntryType, { version: 1, steps: [step('Kept')] }),
      entry(planEntryType, saved('newer.json')),
    ],
    expected: { steps: [step('Kept')], unreadable: [{ kind: 'newer', version: 2 }] },
  },
  {
    name: 'reports a malformed record after a valid plan',
    entries: [
      entry(planEntryType, { version: 1, steps: [step('Kept')] }),
      entry(planEntryType, saved('malformed.json')),
    ],
    expected: { steps: [step('Kept')], unreadable: [{ kind: 'malformed' }] },
  },
  {
    name: 'treats two steps in_progress as malformed',
    entries: [
      entry(planEntryType, {
        version: 1,
        steps: [step('One', 'in_progress'), step('Two', 'in_progress')],
      }),
    ],
    expected: { steps: [], unreadable: [{ kind: 'malformed' }] },
  },
  {
    name: 'treats an extra key as malformed',
    entries: [entry(planEntryType, { version: 1, steps: [step('One')], extra: true })],
    expected: { steps: [], unreadable: [{ kind: 'malformed' }] },
  },
  {
    name: 'clears a valid plan with a later empty plan',
    entries: [
      entry(planEntryType, { version: 1, steps: [step('Gone')] }),
      entry(planEntryType, { version: 1, steps: [] }),
    ],
    expected: { steps: [], unreadable: [] },
  },
  {
    name: 'ignores other custom entries and messages',
    entries: [
      entry('tau-typescript-rules', { version: 1 }),
      { type: 'message', message: { role: 'user', content: 'Do the work.' } },
    ],
    expected: { steps: [], unreadable: [] },
  },
];

it.each(replayCases.map((row) => [row.name, row] as const))(
  '%s',
  (_name, { entries, expected }) => {
    expect(replayPlan(entries)).toEqual(expected);
  },
);

it.each([
  { name: 'clears an empty plan', steps: [], expected: 'Plan cleared.' },
  {
    name: 'counts completed steps',
    steps: [
      step('One', 'completed'),
      step('Two', 'completed'),
      step('Three'),
      step('Four', 'in_progress'),
      step('Five', 'blocked'),
    ],
    expected: 'Plan: 2 of 5 completed.',
  },
])('$name', ({ steps, expected }) => {
  expect(planSummary(steps)).toBe(expected);
});

it.each([
  { name: 'hides an empty plan', steps: [], expected: false },
  {
    name: 'hides a plan whose steps are all completed',
    steps: [step('One', 'completed'), step('Two', 'completed')],
    expected: false,
  },
  {
    name: 'shows a blocked step among completed ones',
    steps: [step('One', 'completed'), step('Two', 'blocked')],
    expected: true,
  },
  { name: 'shows a pending step', steps: [step('One')], expected: true },
])('$name', ({ steps, expected }) => {
  expect(showsPlan(steps)).toBe(expected);
});
