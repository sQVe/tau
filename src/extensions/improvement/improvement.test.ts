import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createExecFake, failedResult, succeededResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { published, sessionHeader, workerLaunch } from '../../../tests/transcriptHarness.js';
import { parseEvent, writeEvent } from '../../improvement/event.js';
import type { ImprovementEvent } from '../../improvement/event.js';
import type { ImprovementStatus } from '../../improvement/statusDecision.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';
import { writeSweepIndex } from '../../improvement/sweepIndex.js';
import type { SweepIndex } from '../../improvement/sweepIndex.js';
import improvementExtension from './improvement.js';

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

type SetStatus = (key: string, text: string | undefined) => void;

const pullRequest = 'https://github.com/sQVe/tau/pull/562';

const evidence: ImprovementEvent['evidence'] = [{ kind: 'pullRequest', url: pullRequest }];

const mergeEvent: ImprovementEvent = {
  version: 1,
  id: 'merge-562',
  kind: 'merge',
  createdAt: '2026-11-15T12:00:00.000Z',
  evidence,
  repository: 'github.com/sQVe/tau',
  pullRequest,
  mergedAt: '2026-11-15T11:58:00.000Z',
};

const factsEvent: ImprovementEvent = {
  version: 1,
  id: 'facts-562',
  kind: 'facts',
  createdAt: '2026-11-15T12:01:00.000Z',
  evidence,
  pullRequest,
  facts: { reviewCaptures: 5 },
  coverage: 'complete',
};

const correctionEvent: ImprovementEvent = {
  version: 1,
  id: 'correction-1',
  kind: 'correction',
  createdAt: '2026-11-15T12:02:00.000Z',
  evidence: [],
  summary: 'Run the focused tests first.',
  cwd: '/code/tau',
};

const sweepIndex = (projectRoot: string, outcome: 'caughtUp' | 'failed'): SweepIndex => ({
  version: 1,
  transcripts: {},
  projects: {
    [projectRoot]: {
      repository: 'sqve/tau',
      merged: { status: 'read', at: '2026-11-15T12:00:00.000Z', count: 1 },
    },
  },
  lastSweep: { startedAt: '2026-11-15T12:00:00.000Z', outcome },
});

const sessionStartContext = (cwd: string, setStatus: SetStatus = () => undefined) =>
  ({ cwd, hasUI: true, ui: { setStatus } }) as unknown as ExtensionContext;

afterEach(() => {
  vi.unstubAllEnvs();
});

const sessionContext = (cwd: string, setStatus: SetStatus) =>
  ({
    cwd,
    hasUI: true,
    ui: { setStatus },
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/sessions/one.jsonl',
    },
  }) as unknown as ExtensionToolContext;

const runManagerToolResult = async (
  cwd: string,
  input: Record<string, unknown>,
  setStatus: SetStatus = () => undefined,
  exec = fakeExtensionApi().pi.exec,
) => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fake = fakeExtensionApi({ exec });

  improvementExtension(fake.pi);
  const tool = fake.tools.get('improvement');

  if (tool === undefined) {
    throw new Error('The manager has no improvement tool.');
  }

  return tool.execute('call-1', input, undefined, undefined, sessionContext(cwd, setStatus));
};

interface RecordDetails {
  id: string;
  path: string;
}

const runManagerTool = async <Details>(
  cwd: string,
  input: Record<string, unknown>,
  setStatus: SetStatus = () => undefined,
): Promise<Details> => {
  const result = await runManagerToolResult(cwd, input, setStatus);

  return result.details as Details;
};

const runTaskTool = async (
  cwd: string,
  input: Record<string, unknown>,
  exec: ReturnType<typeof fakeExtensionApi>['pi']['exec'],
): Promise<unknown> => {
  const result = await runManagerToolResult(cwd, input, () => undefined, exec);

  return result.details;
};

const writeFile = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const mergedPullRequestExec = () =>
  createExecFake<'merged'>({
    keyOf: () => 'merged',
    handlerFor: () => () =>
      succeededResult(
        JSON.stringify({
          number: 7,
          headRefName: 'me-7-change',
          createdAt: '2026-11-01T00:00:00.000Z',
          mergedAt: '2026-11-02T00:00:00.000Z',
        }),
      ),
  });

it('registers no improvement tool in a worker', () => {
  vi.stubEnv('TAU_ROLE', 'worker');
  const fake = fakeExtensionApi();

  improvementExtension(fake.pi);

  expect(fake.tools.has('improvement')).toBe(false);
});

it('starts no sweep in a worker session', () => {
  vi.stubEnv('TAU_ROLE', 'worker');
  const fake = fakeExtensionApi();
  const runSweep = vi.fn<SweepRunner>();

  improvementExtension(fake.pi, { runSweep });

  expect({
    handlers: fake.handlers.get('session_start') ?? [],
    calls: runSweep.mock.calls,
  }).toEqual({
    handlers: [],
    calls: [],
  });
});

it('records a correction from the session the manager runs', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const { path } = await runManagerTool<RecordDetails>(root, {
    action: 'record',
    kind: 'correction',
    summary: 'Use run_tests for tests.',
  });

  const event = parseEvent(path, await readFile(path, 'utf8'));

  expect(event).toMatchObject({
    kind: 'correction',
    summary: 'Use run_tests for tests.',
    cwd: root,
    evidence: [{ kind: 'transcript', path: '/sessions/one.jsonl', toolCallId: 'call-1' }],
  });
});

it('returns tasks, correct due, and coverage from the status action', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const projectRoot = await realpath(root);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');

  await writeEvent(projectRoot, mergeEvent);
  await writeEvent(projectRoot, factsEvent);
  await writeEvent(projectRoot, correctionEvent);
  await writeSweepIndex(agentDirectory, sweepIndex(projectRoot, 'caughtUp'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const status = await runManagerTool<ImprovementStatus>(root, { action: 'status' });

  expect(status).toEqual({
    projectRoot,
    tasks: [
      {
        pullRequest,
        mergedAt: '2026-11-15T11:58:00.000Z',
        signals: ['reviewRounds'],
      },
    ],
    correctDue: true,
    coverage: { complete: 1, managerOnly: 0, missing: 0 },
    sweep: 'complete',
    skipped: [],
  });
});

it('returns the status as one text item that parses to its details', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const projectRoot = await realpath(root);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');

  await writeSweepIndex(agentDirectory, sweepIndex(projectRoot, 'caughtUp'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const result = await runManagerToolResult(root, { action: 'status' });
  const [item] = result.content;

  expect(result.content).toHaveLength(1);
  expect(item).toMatchObject({ type: 'text' });

  const text = item?.type === 'text' ? item.text : '';

  expect(JSON.parse(text)).toEqual(result.details);
});

it('starts a sweep at manager session start', () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fake = fakeExtensionApi();
  const runSweep = vi.fn<SweepRunner>(async () => ({ outcome: 'caughtUp' }));

  improvementExtension(fake.pi, { runSweep });
  fake.handler('session_start')({}, sessionStartContext('/work/me-1'));

  expect(runSweep).toHaveBeenCalledTimes(1);
  expect(runSweep).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/work/me-1' }));
});

it('returns from session start before the sweep finishes', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fake = fakeExtensionApi();
  const { promise, resolve } = Promise.withResolvers<SweepOutcome>();
  const runSweep = vi.fn<SweepRunner>(() => promise);

  improvementExtension(fake.pi, { runSweep });
  const returned = fake.handler('session_start')({}, sessionStartContext('/work/me-1'));

  expect({ returned, calls: runSweep.mock.calls.length }).toEqual({
    returned: undefined,
    calls: 1,
  });

  resolve({ outcome: 'caughtUp' });
  await promise;
});

it('sets the sweep incomplete status after a failed sweep', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const root = await createTemporaryRepository(onTestFinished);
  const projectRoot = await realpath(root);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');
  const setStatus = vi.fn<SetStatus>();
  const { promise, resolve } = Promise.withResolvers<SweepOutcome>();
  const runSweep = vi.fn<SweepRunner>(() => promise);

  await writeSweepIndex(agentDirectory, sweepIndex(projectRoot, 'caughtUp'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const fake = fakeExtensionApi();
  improvementExtension(fake.pi, { runSweep });
  fake.handler('session_start')({}, sessionStartContext(root, setStatus));

  await vi.waitFor(() => {
    expect(setStatus).toHaveBeenCalledWith('improvement', undefined);
  });

  await writeSweepIndex(agentDirectory, sweepIndex(projectRoot, 'failed'));
  resolve({ outcome: 'failed', reason: 'fake failure' });

  await vi.waitFor(() => {
    expect(setStatus).toHaveBeenLastCalledWith('improvement', 'improve: sweep incomplete');
  });
});

it('shows a failed sweep that writes no index as incomplete', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const root = await createTemporaryRepository(onTestFinished);
  const projectRoot = await realpath(root);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');
  const setStatus = vi.fn<SetStatus>();

  const runSweep = vi.fn<SweepRunner>(async () => ({
    outcome: 'failed',
    reason: 'lock failed',
  }));

  await writeSweepIndex(agentDirectory, sweepIndex(projectRoot, 'caughtUp'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const fake = fakeExtensionApi();
  improvementExtension(fake.pi, { runSweep });
  fake.handler('session_start')({}, sessionStartContext(root, setStatus));

  await vi.waitFor(() => {
    expect(setStatus).toHaveBeenLastCalledWith('improvement', 'improve: sweep incomplete');
  });

  const tool = fake.tools.get('improvement');

  if (tool === undefined) {
    throw new Error('The manager has no improvement tool.');
  }

  const result = await tool.execute(
    'call-1',
    { action: 'status' },
    undefined,
    undefined,
    sessionContext(root, setStatus),
  );

  expect(result.details).toMatchObject({ sweep: 'incomplete' });
});

it('clears the status item when nothing is due and the sweep is caught up', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const root = await createTemporaryRepository(onTestFinished);
  const projectRoot = await realpath(root);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');
  const setStatus = vi.fn<SetStatus>();
  const runSweep = vi.fn<SweepRunner>(async () => ({ outcome: 'caughtUp' }));

  await writeSweepIndex(agentDirectory, sweepIndex(projectRoot, 'caughtUp'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const fake = fakeExtensionApi();
  improvementExtension(fake.pi, { runSweep });
  fake.handler('session_start')({}, sessionStartContext(root, setStatus));

  await vi.waitFor(() => {
    expect(setStatus).toHaveBeenLastCalledWith('improvement', undefined);
  });
});

it('refreshes the status item after a record call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const projectRoot = await realpath(root);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');
  const setStatus = vi.fn<SetStatus>();

  await writeSweepIndex(agentDirectory, sweepIndex(projectRoot, 'caughtUp'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  await runManagerTool(
    root,
    { action: 'record', kind: 'correction', summary: 'Use run_tests.' },
    setStatus,
  );

  await vi.waitFor(() => {
    expect(setStatus).toHaveBeenCalledWith('improvement', 'improve: correct due');
  });
});

it('records a review from the session the manager runs', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const { id, path } = await runManagerTool<RecordDetails>(root, {
    action: 'record',
    kind: 'review',
    pullRequest: 'https://github.com/example/repo/pull/1',
    outcome: 'The task passed.',
  });

  const event = parseEvent(path, await readFile(path, 'utf8'));

  expect(id).toMatch(/^review-[0-9a-f]{32}$/u);

  expect(event).toMatchObject({
    id,
    kind: 'review',
    pullRequest: 'https://github.com/example/repo/pull/1',
    outcome: 'The task passed.',
    evidence: [
      { kind: 'transcript', path: '/sessions/one.jsonl', toolCallId: 'call-1' },
      { kind: 'pullRequest', url: 'https://github.com/example/repo/pull/1' },
    ],
  });
});

it('records a backlog item from the session the manager runs', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const review = await runManagerTool<RecordDetails>(root, {
    action: 'record',
    kind: 'review',
    pullRequest: 'https://github.com/example/repo/pull/1',
    outcome: 'The task passed.',
  });

  const { id, path } = await runManagerTool<RecordDetails>(root, {
    action: 'record',
    kind: 'backlog',
    review: review.id,
    item: 2,
    summary: 'Split the module.',
  });

  const event = parseEvent(path, await readFile(path, 'utf8'));

  expect(id).toBe(`backlog-${review.id}-2`);

  expect(event).toMatchObject({
    id,
    kind: 'backlog',
    summary: 'Split the module.',
    pullRequest: 'https://github.com/example/repo/pull/1',
  });
});

it('records a decision from the session the manager runs', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const review = await runManagerTool<RecordDetails>(root, {
    action: 'record',
    kind: 'review',
    pullRequest: 'https://github.com/example/repo/pull/1',
    outcome: 'The task passed.',
  });

  const { id, path } = await runManagerTool<RecordDetails>(root, {
    action: 'record',
    kind: 'decision',
    review: review.id,
    item: 2,
    choice: 'approved',
  });

  const event = parseEvent(path, await readFile(path, 'utf8'));

  expect(id).toBe(`decision-${review.id}-2`);

  expect(event).toMatchObject({ id, kind: 'decision', subject: review.id, choice: 'approved' });
});

it('refuses a record call without a summary', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const failure = await runManagerTool<RecordDetails>(root, {
    action: 'record',
    kind: 'correction',
  }).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect({ failure, saved: existsSync(join(root, '.tau', 'improvement')) }).toEqual({
    failure: 'record kind correction needs summary.',
    saved: false,
  });
});

it('reads a merged task through the improvement tool', async () => {
  const worktree = await createTemporaryRepository(onTestFinished);
  const agent = temporaryDirectory(onTestFinished, 'tau-improvement-task-');
  const exec = mergedPullRequestExec();

  vi.stubEnv('PI_CODING_AGENT_DIR', agent);

  const sessionDirectory = SessionManager.create(worktree).getSessionDir();
  const manager = join(sessionDirectory, 'main.jsonl');
  const worker = join(agent, 'tau', 'main-1', 'workers', 'w1', 'session.jsonl');

  writeFile(manager, [sessionHeader(worktree), ...published(7), ...workerLaunch('w1')].join('\n'));

  writeFile(
    join(agent, 'tau', 'main-1', 'workers', 'w1', 'task.json'),
    '{"taskId":"w1","createdAt":1}',
  );

  writeFile(worker, sessionHeader('/worker'));

  const details = await runTaskTool(
    worktree,
    {
      action: 'task',
      pullRequest: 'https://github.com/owner/repo/pull/7',
      worktree,
    },
    exec.exec,
  );

  expect(details).toEqual({
    pullRequest: 'https://github.com/owner/repo/pull/7',
    manager: [manager],
    workers: [worker],
    coverage: 'complete',
    projectRoot: worktree,
  });
});

it('refuses a task whose merged pull request cannot be read', async () => {
  const worktree = await createTemporaryRepository(onTestFinished);
  const agent = temporaryDirectory(onTestFinished, 'tau-improvement-task-');

  const exec = createExecFake<'merged'>({
    keyOf: () => 'merged',
    handlerFor: () => () => failedResult('HTTP 502'),
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', agent);

  const failure = await runTaskTool(
    worktree,
    {
      action: 'task',
      pullRequest: 'https://github.com/owner/repo/pull/7',
      worktree,
    },
    exec.exec,
  ).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain('https://github.com/owner/repo/pull/7');
});

it('refuses a task whose session folder cannot be read', async () => {
  const worktree = await createTemporaryRepository(onTestFinished);
  const agent = temporaryDirectory(onTestFinished, 'tau-improvement-task-');
  const exec = mergedPullRequestExec();

  vi.stubEnv('PI_CODING_AGENT_DIR', agent);

  const sessionDirectory = SessionManager.create(worktree).getSessionDir();

  rmSync(sessionDirectory, { recursive: true, force: true });
  writeFile(sessionDirectory, 'not a directory');

  const failure = await runManagerTool(
    worktree,
    {
      action: 'task',
      pullRequest: 'https://github.com/owner/repo/pull/7',
      worktree,
    },
    exec.exec,
  ).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain(sessionDirectory);
});

it('returns no project root when the task worktree is gone', async () => {
  const worktree = await createTemporaryRepository(onTestFinished);
  const agent = temporaryDirectory(onTestFinished, 'tau-improvement-task-');
  const exec = mergedPullRequestExec();

  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  rmSync(worktree, { recursive: true, force: true });

  const details = await runTaskTool(
    worktree,
    {
      action: 'task',
      pullRequest: 'https://github.com/owner/repo/pull/7',
      worktree,
    },
    exec.exec,
  );

  expect(details).toMatchObject({
    pullRequest: 'https://github.com/owner/repo/pull/7',
    manager: [],
    workers: [],
    coverage: 'missing',
    projectRoot: null,
  });
});
