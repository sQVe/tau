import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { expect, it, onTestFinished, vi } from 'vitest';

import { saveReport, writeAssignment } from './assignment.js';
import type { SavedReport } from './assignment.js';
import {
  assignmentFor,
  dispatch,
  sendStartMessage,
  setup,
} from './fixtures/workerExtensionHarness.js';

vi.mock(import('node:fs/promises'), { spy: true });

const start = 1_700_000_000_000;
const warningReserve = 90_000;

const withFakeTimers = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(start);

  onTestFinished(() => {
    vi.useRealTimers();
  });
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

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  await vi.advanceTimersByTimeAsync(120_000 - warningReserve - 1);

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
  withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });

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

  expect(vi.getTimerCount()).toBe(0);

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
  withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  expect(vi.getTimerCount()).toBe(1);

  pi.handler('session_shutdown')({}, context);

  expect(vi.getTimerCount()).toBe(0);

  await vi.advanceTimersByTimeAsync(120_000);
  await flushAsync();

  expect(pi.sendMessage).not.toHaveBeenCalled();
});

it('shows no warning when the assignment already has a report before the start', async () => {
  withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({
    ...assignmentFor(directory),
    deadline: start + 120_000,
    report: savedReport,
  });

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  expect(vi.getTimerCount()).toBe(0);

  await vi.advanceTimersByTimeAsync(120_000);

  expect(pi.sendMessage).not.toHaveBeenCalled();
});

it('shows no warning when a report is saved after the warning is armed', async () => {
  withFakeTimers();
  const { assignmentPath, context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });

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
  withFakeTimers();
  const { context, directory, pi } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);
  await sendStartMessage(pi, context);

  await vi.advanceTimersByTimeAsync(30_000);

  await vi.waitFor(() => {
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  await vi.advanceTimersByTimeAsync(120_000);

  expect(pi.sendMessage).toHaveBeenCalledTimes(1);
});

it('keeps a question wait when the deadline warning turn settles', async () => {
  withFakeTimers();
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment({ ...assignmentFor(directory), deadline: start + 120_000 });

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
