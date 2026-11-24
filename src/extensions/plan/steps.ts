import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { isRecord, newerRecordVersion, stringEnum } from '../../schema.js';

type CheckedSteps = { kind: 'accepted' } | { kind: 'refused'; reason: string };

type UnreadablePlan = { kind: 'newer'; version: number } | { kind: 'malformed' };

type PlanEntryData = { kind: 'plan'; steps: readonly PlanStep[] } | UnreadablePlan;

const planStatuses = ['pending', 'in_progress', 'completed', 'blocked'] as const;

export const planStepSchema = Type.Object(
  {
    text: Type.String(),
    status: stringEnum(planStatuses),
  },
  { additionalProperties: false },
);

export type PlanStep = Static<typeof planStepSchema>;

export const planEntryType = 'tau-plan';
export const maxPlanSteps = 12;

const planRecordVersion = 1;

const planRecordSchema = Type.Object(
  { version: Type.Literal(planRecordVersion), steps: Type.Array(planStepSchema) },
  { additionalProperties: false },
);

export type PlanRecord = Static<typeof planRecordSchema>;

export const planRecord = (steps: readonly PlanStep[]): PlanRecord => ({
  version: planRecordVersion,
  steps: [...steps],
});

export const checkSteps = (steps: readonly PlanStep[]): CheckedSteps => {
  if (steps.length > maxPlanSteps) {
    return {
      kind: 'refused',
      reason: `A plan holds at most ${maxPlanSteps} steps; got ${steps.length}.`,
    };
  }

  const emptyIndex = steps.findIndex((step) => step.text.trim() === '');

  if (emptyIndex !== -1) {
    return { kind: 'refused', reason: `Step ${emptyIndex + 1} has no text.` };
  }

  const unsupportedIndex = steps.findIndex(
    (step) => !planStatuses.some((status) => status === step.status),
  );

  if (unsupportedIndex !== -1) {
    const status: unknown = steps[unsupportedIndex]?.status;

    return {
      kind: 'refused',
      reason: `Step ${unsupportedIndex + 1} has unknown status "${String(status)}".`,
    };
  }

  const inProgress = steps.filter((step) => step.status === 'in_progress').length;

  if (inProgress > 1) {
    return {
      kind: 'refused',
      reason: `Mark at most one step in_progress; got ${inProgress}.`,
    };
  }

  return { kind: 'accepted' };
};

const planEntryData = (data: unknown): PlanEntryData => {
  const claimedVersion = newerRecordVersion(data, planRecordVersion);

  if (claimedVersion !== undefined) {
    return { kind: 'newer', version: claimedVersion };
  }

  if (!Value.Check(planRecordSchema, data) || checkSteps(data.steps).kind === 'refused') {
    return { kind: 'malformed' };
  }

  return { kind: 'plan', steps: data.steps };
};

export const replayPlan = (
  entries: readonly unknown[],
): { steps: readonly PlanStep[]; unreadable: UnreadablePlan[] } => {
  let steps: readonly PlanStep[] = [];
  const unreadable: UnreadablePlan[] = [];

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== planEntryType) {
      continue;
    }

    const data = planEntryData(entry.data);

    if (data.kind === 'plan') {
      steps = data.steps;
    } else {
      unreadable.push(data);
    }
  }

  return { steps, unreadable };
};

export const showsPlan = (steps: readonly PlanStep[]): boolean =>
  steps.some((step) => step.status !== 'completed');

export const planSummary = (steps: readonly PlanStep[]): string => {
  if (steps.length === 0) {
    return 'Plan cleared.';
  }

  const completed = steps.filter((step) => step.status === 'completed').length;

  return `Plan: ${completed} of ${steps.length} completed.`;
};
