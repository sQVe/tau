import type { AgentBeforeSettleEvent } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import type { Assignment } from './assignment.js';
import type { ReportTarget } from './report.js';
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

const target = (overrides: Partial<ReportTarget> = {}): ReportTarget => ({
  hc: {
    exec: () => Promise.reject(new Error('not used')),
    connect: () => Promise.reject(new Error('not used')),
    cwd: '/',
  },
  terminal: 'worker-1',
  parent: 'manager-1',
  assignmentPath: 'assignment.json',
  assignment: assignment(),
  refusal: { incompleteRefused: false, reminderSent: false, remindAfterRefusal: false },
  ...overrides,
});

const state = (overrides: Partial<ReminderState> = {}): ReminderState => ({
  target: target(),
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
      target: target({
        refusal: { incompleteRefused: false, reminderSent: true, remindAfterRefusal: false },
      }),
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
      target: target({
        refusal: { incompleteRefused: false, reminderSent: true, remindAfterRefusal: false },
      }),
    });

    worker.target.refusal.remindAfterRefusal = true;

    expect(remindToReport(worker, event)).toMatchObject({ continue: true });
    expect(worker.target.refusal.remindAfterRefusal).toBe(false);
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

    expect(remindToReport(state({ target: target({ assignment: saved }) }), event)).toBeUndefined();
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
