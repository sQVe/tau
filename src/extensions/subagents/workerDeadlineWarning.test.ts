import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { expect, it, onTestFinished, vi } from 'vitest';

import { saveReport, writeAssignment } from './assignment.js';
import type { SavedReport } from './assignment.js';
import { deadlineWarningDelay, deadlineWarningReserve } from './deadlineDecision.js';
import {
  assignmentFor,
  dispatch,
  savePassingFullCheck,
  sendStartMessage,
  setup,
} from './fixtures/workerExtensionHarness.js';

interface FakeClock {
  armedWarningTimers: () => number;
}

vi.mock(import('node:fs/promises'), { spy: true });

const start = 1_700_000_000_000;
const warningDelay = deadlineWarningDelay(start + 120_000, start);
const outputIdleMilliseconds = 100;

// Git arms a timer to drain a child's streams when the child exits, and the extension's scan runs
// git without a test awaiting it, so a count of every timer also counts git's. Count the timer the
// warning arms, which is the only one this test arms with that delay.
const withFakeTimers = (): FakeClock => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(start);

  const setTimeoutFake = globalThis.setTimeout;
  const clearTimeoutFake = globalThis.clearTimeout;
  const armedTimers = new Map<unknown, number>();

  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    const handle = setTimeoutFake(() => {
      armedTimers.delete(handle);
      callback(...args);
    }, delay);

    armedTimers.set(handle, delay ?? 0);

    return handle;
  });

  vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
    armedTimers.delete(handle);
    clearTimeoutFake(handle);
  });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  return {
    armedWarningTimers: () =>
      [...armedTimers.values()].filter((delay) => delay === warningDelay).length,
  };
};

const warningContent = (pi: ReturnType<typeof setup>['pi']): unknown =>
  pi.sendMessage.mock.calls[0]?.[0].content;

// Let a fired warning finish its async assignment read before asserting no wake.
const flushAsync = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

const deferred = () => {
  let settle!: () => void;

  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });

  return { promise, resolve: settle };
};

it('warns once 30 s before a deadline 120 s away, and not before', async () => {
  withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });
  await savePassingFullCheck(directory);

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  await vi.advanceTimersByTimeAsync(120_000 - deadlineWarningReserve - 1);

  expect(pi.sendMessage).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);

  await vi.waitFor(() => {
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  expect(warningContent(pi)).toContain('Deadline in 90 s');
  expect(warningContent(pi)).toContain('blockerKind time is accepted.');

  expect(pi.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    customType: 'tau-worker-deadline-warning',
    display: true,
  });

  await vi.advanceTimersByTimeAsync(120_000);

  expect(pi.sendMessage).toHaveBeenCalledTimes(1);
});

const reportSummary = 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None';

const savedReport: SavedReport = {
  outcome: 'success',
  summary: reportSummary,
  evidence: [],
};

it('shows no warning when the worker reports before the warning time', async () => {
  const clock = withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });
  await savePassingFullCheck(directory);

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  const report = pi.tools.get('subagent_report');

  if (report === undefined) {
    throw new Error('The report tool was not registered.');
  }

  await report.execute(
    'report',
    { outcome: 'success', summary: reportSummary, evidence: [] },
    undefined,
    undefined,
    context,
  );

  // A timer that belongs to git's stream drain, not to the warning: the count must ignore it.
  setTimeout(() => undefined, outputIdleMilliseconds);

  expect(clock.armedWarningTimers()).toBe(0);

  await vi.advanceTimersByTimeAsync(120_000);

  expect(pi.sendMessage).not.toHaveBeenCalled();
});

it('arms only after the start message, warning at once with 60 s left', async () => {
  withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 60_000 });

  await pi.handler('session_start')({}, context);

  await pi.handler('input')({ type: 'input', text: 'Use A.', source: 'rpc' }, context);
  await vi.advanceTimersByTimeAsync(0);

  expect(pi.sendMessage).not.toHaveBeenCalled();

  await sendStartMessage(pi, context);
  await vi.advanceTimersByTimeAsync(0);

  await vi.waitFor(() => {
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  expect(warningContent(pi)).toContain('Deadline in 60 s');
});

it('shows no warning after session_shutdown', async () => {
  const clock = withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });
  await savePassingFullCheck(directory);

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  expect(clock.armedWarningTimers()).toBe(1);

  pi.handler('session_shutdown')({}, context);

  expect(clock.armedWarningTimers()).toBe(0);

  await vi.advanceTimersByTimeAsync(120_000);
  await flushAsync();

  expect(pi.sendMessage).not.toHaveBeenCalled();
});

it('shows no warning when the assignment already has a report before the start', async () => {
  const clock = withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({
    ...assignmentFor(directory),
    deadline: start + 120_000,
    report: savedReport,
  });

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  expect(clock.armedWarningTimers()).toBe(0);

  await vi.advanceTimersByTimeAsync(120_000);

  expect(pi.sendMessage).not.toHaveBeenCalled();
});

it('shows no warning when a report is saved after the warning is armed', async () => {
  withFakeTimers();
  const { assignmentPath, context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });
  await savePassingFullCheck(directory);

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  await saveReport(assignmentPath, savedReport);
  await vi.advanceTimersByTimeAsync(120_000);
  await flushAsync();

  expect(pi.sendMessage).not.toHaveBeenCalled();
});

it('shows no warning when the warning is cleared while the report read is pending', async () => {
  withFakeTimers();
  const { assignmentPath, context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });
  await savePassingFullCheck(directory);

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  const readPending = deferred();
  const assignmentText = readFileSync(assignmentPath, 'utf8');

  vi.mocked(readFile).mockImplementationOnce(async () => {
    await readPending.promise;

    return assignmentText;
  });

  await vi.advanceTimersByTimeAsync(30_000);

  pi.handler('session_shutdown')({}, context);

  readPending.resolve();
  await flushAsync();

  expect(pi.sendMessage).not.toHaveBeenCalled();
});

it('does not warn again when the start message arrives twice', async () => {
  const clock = withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });
  await savePassingFullCheck(directory);

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);
  await sendStartMessage(pi, context);

  expect(clock.armedWarningTimers()).toBe(1);

  await vi.advanceTimersByTimeAsync(30_000);

  await vi.waitFor(() => {
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  await vi.advanceTimersByTimeAsync(120_000);

  expect(pi.sendMessage).toHaveBeenCalledTimes(1);
});

it('leaves no timer armed once the warning fires', async () => {
  const clock = withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });
  await savePassingFullCheck(directory);

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  expect(clock.armedWarningTimers()).toBe(1);

  await vi.advanceTimersByTimeAsync(warningDelay);

  expect(clock.armedWarningTimers()).toBe(0);
});

it('keeps a question wait when the deadline warning turn settles', async () => {
  withFakeTimers();
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });
  await savePassingFullCheck(directory);

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  const question = pi.tools.get('subagent_question');

  if (question === undefined) {
    throw new Error('The question tool was not registered.');
  }

  await question.execute(
    'question',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  await vi.advanceTimersByTimeAsync(30_000);

  await vi.waitFor(() => {
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  dispatch(pi, 'agent_start', {}, context);
  dispatch(pi, 'agent_settled', {}, context);

  expect(shutdown).not.toHaveBeenCalled();

  pi.handler('message_start')(
    { type: 'message_start', message: { role: 'user', content: 'Use A.' } },
    context,
  );

  dispatch(pi, 'agent_start', {}, context);
  dispatch(pi, 'agent_settled', {}, context);

  expect(shutdown).toHaveBeenCalledOnce();
});
