import type { AgentBeforeSettleEvent } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import type { Assignment } from './assignment.js';
import { remindToReport } from './reportReminder.js';
import type { ReminderState } from './reportReminder.js';

const createdAt = 1_000_000;
const deadline = createdAt + 30_000;

const assignment = (overrides: Partial<Assignment> = {}): Assignment =>
  ({
    assignmentId: 'a',
    task: 'Work.',
    acceptance: [],
    createdAt,
    deadline,
    report: null,
    ...overrides,
  }) as Assignment;

const state = (overrides: Partial<ReminderState> = {}): ReminderState => ({
  assignment: assignment(),
  refusal: { incompleteRefused: false, reminderSent: false, remindAfterRefusal: false },
  runError: undefined,
  ...overrides,
});

const event = { entries: [] } as unknown as AgentBeforeSettleEvent;

it('asks for a report while work time remains', () => {
  vi.useFakeTimers();
  vi.setSystemTime(deadline - 1);

  try {
    expect(remindToReport(state(), event)).toMatchObject({ continue: true });
  } finally {
    vi.useRealTimers();
  }
});

it('asks only once without a refused report', () => {
  vi.useFakeTimers();
  vi.setSystemTime(deadline - 1);

  try {
    const worker = state({
      refusal: { incompleteRefused: false, reminderSent: true, remindAfterRefusal: false },
    });

    expect(remindToReport(worker, event)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('asks again after a refused report', () => {
  vi.useFakeTimers();
  vi.setSystemTime(deadline - 1);

  try {
    const worker = state({
      refusal: { incompleteRefused: false, reminderSent: true, remindAfterRefusal: false },
    });

    worker.refusal.remindAfterRefusal = true;

    expect(remindToReport(worker, event)).toMatchObject({ continue: true });
    expect(worker.refusal.remindAfterRefusal).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('sends no reminder when no work time remains', () => {
  vi.useFakeTimers();
  vi.setSystemTime(deadline);

  try {
    expect(remindToReport(state(), event)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('sends no reminder after the report is saved', () => {
  vi.useFakeTimers();
  vi.setSystemTime(deadline - 1);

  try {
    const saved = assignment({ report: { outcome: 'success', summary: 'Done.', evidence: [] } });

    expect(remindToReport(state({ assignment: saved }), event)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('sends no reminder after an errored run', () => {
  vi.useFakeTimers();
  vi.setSystemTime(deadline - 1);

  try {
    expect(
      remindToReport(state({ runError: 'Pi run ended with error: boom' }), event),
    ).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
