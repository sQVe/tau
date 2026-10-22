import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentBeforeSettleEvent } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { remindToReport } from './reportReminder.js';
import type { Task } from './types.js';
import type { WorkerExtensionState } from './workerExtensionState.js';

const monotonicDeadline = 50_000;
const cancellationBudget = 1000;
const nanosecondsPerMillisecond = 1_000_000;

const settingWorker = (monotonicNow: number) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-report-reminder-');

  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  vi.spyOn(process.hrtime, 'bigint').mockReturnValue(
    BigInt(monotonicNow * nanosecondsPerMillisecond),
  );

  const state = {
    directory,
    task: { taskId: 'task', cancellationBudget } as Task,
    monotonicDeadline,
    accepted: true,
    settled: false,
    reported: false,
    remindAfterRefusal: false,
    pendingQuestion: undefined,
    runError: undefined,
  } as WorkerExtensionState;

  return { directory, state };
};

const event = { entries: [] } as unknown as AgentBeforeSettleEvent;

it('asks for a report while work time remains', () => {
  const { directory, state } = settingWorker(monotonicDeadline - cancellationBudget - 1);

  expect(remindToReport(state, event)).toMatchObject({ continue: true });
  expect(existsSync(join(directory, 'reportRequest.json'))).toBe(true);
});

it('sends no reminder when no work time remains', () => {
  const { directory, state } = settingWorker(monotonicDeadline - cancellationBudget);

  expect(remindToReport(state, event)).toBeUndefined();
  expect(existsSync(join(directory, 'reportRequest.json'))).toBe(false);
});
