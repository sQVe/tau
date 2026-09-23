import type * as fileSystem from 'node:fs';
import {
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import { inheritedInstructions } from './admission.js';
import * as cancellationModule from './cancellation.js';
import {
  EvidenceUnavailableError,
  WorkerController,
  taskStatus,
  workerArguments,
} from './controller.js';
import type { HerdrClient } from './controller.js';
import { herdrFake } from './fixtures/herdrFake.js';
import { fixtureLoadout, readPiTask as readTask } from './fixtures/loadout.js';
import { searchHistory } from './history.js';
import * as identity from './identity.js';
import * as loadoutModule from './loadout.js';
import * as names from './names.js';
import { WorkerPlacement } from './placement.js';
import { placementFixture } from './placementFixture.js';
import type { WorkerNotice } from './presentation.js';
import * as questions from './questionRecords.js';
import { acceptReport, readEvent, recordEvent } from './records.js';
import * as records from './records.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fileSystem>();

  return { ...original, fsyncSync: vi.fn<typeof fsyncSync>(original.fsyncSync) };
});

const originalRunClient = cancellationModule.runClient;

const setup = (
  onTestFinished: (callback: () => void) => void,
  readyDelay = 0,
  intercept?: HerdrClient,
) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-controller-'));
  onTestFinished(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  // The fake worker uses this test process; the parent must have a distinct identity.
  vi.spyOn(identity, 'currentProcessIdentity').mockResolvedValue({
    processId: process.pid + 1,
    startedAt: 'fixture parent',
  });
  writeFileSync(
    join(directory, 'parent.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: 'parent-id', cwd: directory })}\n`,
  );
  const fake = herdrFake('pi');
  fake.state.shell = 100;
  vi.spyOn(cancellationModule, 'runClient').mockImplementation(
    (executable, argumentsList, budget, options) => {
      if (executable === 'ps' && argumentsList[1] === '100') {
        return Promise.resolve('fixture shell start');
      }

      return originalRunClient(executable, argumentsList, budget, options);
    },
  );
  // Input delivery fails in these tests, so the worker process stays alive after cancellation.
  fake.state.sendKeysError = 'Injected herdr failure; active process remains alive.';
  fake.state.promptError = 'Injected herdr failure; active process remains alive.';
  let recordDirectory = '';
  const calls: string[][] = [];
  let startAttempted = false;
  const client: HerdrClient = async (argumentsList, budget, signal) => {
    calls.push(argumentsList);

    if (argumentsList[1] === 'start') {
      startAttempted = true;
    }

    if (argumentsList[1] === 'process-info' && !startAttempted) {
      return fake.client(argumentsList, budget, signal);
    }

    if (intercept) {
      const response = await intercept(argumentsList, budget, signal);

      if (response) {
        return response;
      }
    }

    if (argumentsList[1] === 'split' || argumentsList[1] === 'create') {
      recordDirectory =
        argumentsList
          .find((argument) => argument.startsWith('TAU_WORKER_RECORD='))
          ?.slice('TAU_WORKER_RECORD='.length) ?? '';
    }

    if (argumentsList[1] === 'start') {
      const token = argumentsList[argumentsList.indexOf('--session') + 1] ?? '';
      fake.state.session = token;
      fake.state.processArguments = ['pi', token];
      const task = readTask(recordDirectory);
      const ready = () => {
        recordEvent(recordDirectory, task.taskId, 'ready', {
          detail: 'Ready.',
          processId: process.pid,
        });
      };

      if (readyDelay > 0) {
        setTimeout(ready, readyDelay);
      } else if (readyDelay === 0) {
        ready();
      }
    }

    return fake.client(argumentsList, budget, signal);
  };
  const notifications: WorkerNotice[] = [];
  const controller = new WorkerController(directory, client, (notice) =>
    notifications.push(notice),
  );
  onTestFinished(() => {
    controller.close();
  });
  const input = {
    task: 'Edit fixture and test it.',
    loadout: fixtureLoadout(directory),
    timeout: 10_000,
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent-id',
    parentPane: 'parent',
  };

  return { directory, controller, client, fake, calls, notifications, input };
};

it.each(['missing', 'empty'] as const)(
  'confirms rejected Pi startup with %s agent evidence',
  async (evidence) => {
    const fixture = setup(afterTest, -1, async (argumentsList) => {
      if (evidence === 'empty' && argumentsList[1] === 'get') {
        return JSON.stringify({ result: { agent: {} } });
      }

      return '';
    });
    fixture.fake.state.startError = 'agent_pane_busy';
    fixture.fake.state.rejectStart = true;

    const launched = await fixture.controller.launch(fixture.input);

    expect(launched.state).toBe('stopped');
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
    expect(fixture.controller.children().active).toBe(0);
    expect(fixture.calls.some((call) => call[1] === 'send-keys')).toBe(false);
    expect(fixture.calls.filter((call) => call[1] === 'close')).toEqual([
      ['pane', 'close', 'worker-1'],
    ]);
  },
);

it('does not close a rejected-start pane after its foreground changes', async ({
  onTestFinished,
}) => {
  let absenceChecks = 0;
  const fixture = setup(onTestFinished, -1, async (argumentsList) => {
    if (argumentsList[1] === 'get') {
      absenceChecks += 1;
    }

    if (absenceChecks > 0 && argumentsList[1] === 'process-info') {
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: argumentsList[3],
            shell_pid: 100,
            foreground_process_group_id: process.pid,
            foreground_processes: [{ pid: process.pid, argv: ['unrelated-job'] }],
          },
        },
      });
    }

    return '';
  });
  fixture.fake.state.startError = 'agent_pane_busy';
  fixture.fake.state.rejectStart = true;

  const launched = await fixture.controller.launch(fixture.input);

  expect(launched.cleanup).toContain('pane closure refused');
  expect(launched.state).toBe('cleanupUnconfirmed');
  expect(launched.capacityHeld).toBe(true);
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(false);
  expect(fixture.calls.some((call) => call[1] === 'close')).toBe(false);
  expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toContain('worker-1');
});

it('keeps confirmed cleanup when placement fails after the rejected-start pane closes', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished, -1);
  fixture.fake.state.startError = 'Start rejected';
  fixture.fake.state.rejectStart = true;
  const close = WorkerPlacement.prototype.close;
  vi.spyOn(WorkerPlacement.prototype, 'close').mockImplementation(async function (
    this: WorkerPlacement,
    ...argumentsList
  ) {
    await close.apply(this, argumentsList);

    throw new Error('Placement update failed after closure');
  });

  const launched = await fixture.controller.launch(fixture.input);

  expect(launched.state).toBe('stopped');
  expect(launched.capacityHeld).toBe(false);
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
  expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
});

it.each(['fails', 'aborts', 'times out'] as const)(
  'stops Pi when the start response %s after launch',
  async (outcome) => {
    const abort = new AbortController();
    const fixture = setup(afterTest, -1);
    const client = fixture.fake.client;
    vi.spyOn(fixture.fake, 'client').mockImplementation(async (argumentsList, budget, signal) => {
      try {
        return await client(argumentsList, budget, signal);
      } finally {
        if (outcome === 'aborts' && argumentsList[1] === 'start') {
          abort.abort();
        }
      }
    });
    fixture.fake.state.startError =
      outcome === 'times out'
        ? 'Client attempt budget expired; delivery and cleanup are unconfirmed.'
        : 'Start response lost';
    fixture.fake.state.sendKeysError = '';
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (fixture.fake.state.stopped) {
        throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
      }

      return true;
    });

    const launched = await fixture.controller.launch(fixture.input, abort.signal);

    expect(launched.state).toBe('stopped');
    expect(fixture.fake.state.stopped).toBe(true);
    expect(fixture.controller.children().active).toBe(0);
    expect(fixture.calls.some((call) => call[1] === 'close')).toBe(true);
  },
);

it('requires two matching bare-shell samples after transient startup children', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished);
  const client = fixture.fake.client;
  let samples = 0;
  let samplesAtStart = 0;
  vi.spyOn(fixture.fake, 'client').mockImplementation((argumentsList, budget, signal) => {
    if (!fixture.fake.state.started && argumentsList[1] === 'process-info') {
      samples += 1;

      if (samples === 2) {
        fixture.fake.state.busyShellPolls = 1;
      }
    }

    if (argumentsList[1] === 'start') {
      samplesAtStart = samples;
    }

    return client(argumentsList, budget, signal);
  });

  const launched = await fixture.controller.launch(fixture.input);

  expect(launched.state).toBe('starting');
  expect(samplesAtStart).toBeGreaterThanOrEqual(5);
});

it('retries a structured pane-busy rejection once after proving absence', async ({
  onTestFinished,
}) => {
  let attempts = 0;
  const fixture = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'start') {
      attempts += 1;

      if (attempts === 1) {
        throw Object.assign(new Error('Busy shell'), {
          stderr: JSON.stringify({ error: { code: 'agent_pane_busy' } }),
        });
      }
    }

    return '';
  });

  const launched = await fixture.controller.launch(fixture.input);

  expect(launched.state).toBe('starting');
  expect(attempts).toBe(2);
  expect(records.readRecord(launched.directory, 'startRetry.json')).toMatchObject({
    taskId: launched.taskId,
  });
});

it('does not repeat a second structured pane-busy rejection', async ({ onTestFinished }) => {
  let attempts = 0;
  const fixture = setup(onTestFinished, -1, async (argumentsList) => {
    if (argumentsList[1] === 'start') {
      attempts += 1;
      throw Object.assign(new Error('Busy shell'), {
        stderr: JSON.stringify({ error: { code: 'agent_pane_busy' } }),
      });
    }

    return '';
  });

  const launched = await fixture.controller.launch(fixture.input);

  expect(attempts).toBe(2);
  expect(launched.state).toBe('stopped');
  expect(fixture.controller.children().active).toBe(0);
  expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
});

it('waits for the split shell before starting Pi', async ({ onTestFinished }) => {
  const fixture = setup(onTestFinished);
  fixture.fake.state.busyShellPolls = 2;

  const launched = await fixture.controller.launch(fixture.input);

  expect(launched.state).toBe('starting');
  expect(fixture.fake.state.started).toBe(true);
  expect(fixture.fake.state.busyShellPolls).toBe(0);
});

it('skips unpublished preparation debris while published attempts and claims remain exclusive', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished);
  writeFileSync(
    fixture.input.parentSession,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: fixture.input.parentSessionId,
      cwd: fixture.directory,
    }) + '\n',
  );
  const originalPublish = records.publish;
  const preparation = vi.spyOn(records, 'publish').mockImplementation((directory, name, value) => {
    if (name === 'task.json') {
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw new Error('Initial task file sync failed.');
      });
      preparation.mockRestore();
    }

    originalPublish(directory, name, value);
  });
  await expect(fixture.controller.launch(fixture.input)).rejects.toThrow('Task preparation');
  const abandoned = readdirSync(fixture.directory, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name !== '.admission',
  );

  if (!abandoned) {
    throw new Error('Missing preparation evidence.');
  }

  const abandonedDirectory = join(fixture.directory, abandoned.name);
  const receiptFiles = readdirSync(abandonedDirectory);
  expect(receiptFiles).toHaveLength(1);
  expect(receiptFiles[0]).toMatch(/^\.receipt-/);
  const receipt = readFileSync(join(abandonedDirectory, receiptFiles[0] ?? ''));

  expect(fixture.controller.children()).toEqual({
    active: 0,
    uncertain: [expect.stringContaining(abandonedDirectory)],
  });
  const launched = await fixture.controller.launch(fixture.input);
  expect(launched.state).toBe('starting');
  expect(launched).not.toHaveProperty('outcome');
  const current = {
    file: fixture.input.parentSession,
    id: fixture.input.parentSessionId,
    sessionDirectory: fixture.directory,
  };
  const history = await searchHistory(fixture.directory, current);
  expect(history.candidates.some((candidate) => candidate.taskId === launched.taskId)).toBe(true);
  expect(history.diagnostics.join(' ')).toContain(abandoned.name);
  expect(readFileSync(join(abandonedDirectory, receiptFiles[0] ?? ''))).toEqual(receipt);
  records.acceptReport(launched.directory, launched.taskId, {
    taskId: launched.taskId,
    outcome: 'success',
    summary: 'Finished.',
    evidence: [],
  });
  recordEvent(launched.directory, launched.taskId, 'cleanup', {
    detail: 'Parent confirmed.',
    stopped: true,
  });
  fixture.controller.close();
  const controller = new WorkerController(fixture.directory, fixture.client);
  onTestFinished(() => {
    controller.close();
  });
  const attemptDirectory = join(fixture.directory, 'published-attempt');
  mkdirSync(attemptDirectory);
  const attempt = records.validateTask({
    ...readTask(launched.directory),
    taskId: 'published-attempt',
    predecessorTaskId: launched.taskId,
  });
  records.publish(attemptDirectory, 'task.json', attempt);
  recordEvent(attemptDirectory, attempt.taskId, 'accepted', 'Accepted attempt.');
  const input = {
    task: 'Follow up.',
    sourceTaskId: launched.taskId,
    settingsUnchanged: true,
    timeout: 10000,
    parentSession: current.file,
    parentSessionId: current.id,
    parentPane: 'parent',
  };
  const context = { cwd: fixture.directory, isProjectTrusted: () => true } as Parameters<
    WorkerController['followUp']
  >[1];

  await expect(controller.followUp(input, context)).rejects.toThrow('published-attempt');
  records.claimSuccessor(launched.directory, attempt);
  await expect(controller.followUp(input, context)).rejects.toThrow('published-attempt');
  expect(records.readSuccessor(launched.directory)?.successorTaskId).toBe(attempt.taskId);
  expect(readdirSync(abandonedDirectory)).toEqual(receiptFiles);
});

const completed = async (intercept?: HerdrClient) => {
  const fixture = setup(afterTest, 0, intercept);
  writeFileSync(
    fixture.input.parentSession,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: fixture.input.parentSessionId,
      cwd: fixture.directory,
    }) + '\n',
  );
  const status = await fixture.controller.launch(fixture.input);
  records.acceptReport(status.directory, status.taskId, {
    taskId: status.taskId,
    outcome: 'success',
    summary: 'Finished.',
    evidence: ['Checked.'],
  });
  recordEvent(status.directory, status.taskId, 'settled', {
    detail: 'Worker settled.',
    stopped: true,
  });
  recordEvent(status.directory, status.taskId, 'cleanup', {
    detail: 'Parent confirmed exit.',
    stopped: true,
  });
  fixture.controller.close();
  const controller = new WorkerController(fixture.directory, fixture.client);
  afterTest(() => {
    controller.close();
  });
  const validation = vi
    .spyOn(loadoutModule, 'validateSavedLoadout')
    .mockImplementation(async (value) => value as ReturnType<typeof readTask>['loadout']);
  const context = { cwd: fixture.directory, isProjectTrusted: () => true } as Parameters<
    typeof loadoutModule.validateSavedLoadout
  >[1];
  const input = {
    task: 'Follow up within saved settings.',
    sourceTaskId: status.taskId,
    timeout: 12000,
    settingsUnchanged: true,
    parentSession: fixture.input.parentSession,
    parentSessionId: fixture.input.parentSessionId,
    parentPane: fixture.input.parentPane,
  };

  return {
    ...fixture,
    controller,
    validation,
    context,
    input,
    source: readTask(status.directory),
    sourceDirectory: status.directory,
  };
};

it('retains the follow-up claim when final absence verification fails', async () => {
  let following = false;
  let absenceChecks = 0;
  const fixture = await completed(async (argumentsList) => {
    if (!following) {
      return '';
    }

    if (argumentsList[1] === 'get') {
      absenceChecks += 1;
    }

    if (absenceChecks > 0 && argumentsList[1] === 'process-info') {
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: argumentsList[3],
            shell_pid: 100,
            foreground_process_group_id: process.pid,
            foreground_processes: [{ pid: process.pid, argv: ['unrelated-job'] }],
          },
        },
      });
    }

    return '';
  });
  following = true;
  fixture.fake.state.startError = 'Start rejected';
  fixture.fake.state.rejectStart = true;

  const failed = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(failed.state).toBe('cleanupUnconfirmed');
  expect(failed.capacityHeld).toBe(true);
  expect(readEvent(failed.directory, failed.taskId, 'cleanup')?.stopped).toBe(false);
  expect(records.readSuccessor(fixture.sourceDirectory)?.successorTaskId).toBe(failed.taskId);
  expect(fixture.calls.some((call) => call[1] === 'close')).toBe(false);
  const calls = fixture.calls.length;
  const claim = readFileSync(join(fixture.sourceDirectory, 'successor.json'));

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    failed.taskId,
  );

  expect(fixture.calls).toHaveLength(calls);
  expect(readFileSync(join(fixture.sourceDirectory, 'successor.json'))).toEqual(claim);
});

it('allows follow-up retry after a rejected start and confirmed cleanup', async () => {
  const fixture = await completed();
  fixture.fake.state.startError = 'agent_pane_busy';
  fixture.fake.state.rejectStart = true;

  const failed = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(failed.state).toBe('stopped');
  expect(records.readSuccessor(fixture.sourceDirectory)).toBeUndefined();
  fixture.fake.state.startError = '';
  fixture.fake.state.rejectStart = false;
  const retried = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(retried.state).toBe('starting');
  expect(retried.taskId).not.toBe(failed.taskId);
  expect(records.readSuccessor(fixture.sourceDirectory)?.successorTaskId).toBe(retried.taskId);
});

it('follows up a completed native task with new identity and unchanged saved evidence', async () => {
  const fixture = await completed();
  const taskBytes = readFileSync(join(fixture.sourceDirectory, 'task.json'));
  const reportBytes = readFileSync(join(fixture.sourceDirectory, 'report.json'));
  const nativeBytes = readFileSync(fixture.source.nativeSessionFile);
  expect(fixture.controller).toHaveProperty('followUp');
  const next = await fixture.controller.followUp(fixture.input, fixture.context);
  const task = readTask(next.directory);

  expect(task.taskId).not.toBe(fixture.source.taskId);
  expect(task.deadline).not.toBe(fixture.source.deadline);
  expect(task).toMatchObject({
    predecessorTaskId: fixture.source.taskId,
    nativeSessionId: fixture.source.nativeSessionId,
    nativeSessionFile: fixture.source.nativeSessionFile,
    loadout: fixture.source.loadout,
  });
  expect(task.name).not.toBe(fixture.source.name);
  expect(next).toMatchObject({
    predecessorTaskId: fixture.source.taskId,
    predecessorName: fixture.source.name,
  });
  expect(taskStatus(next.directory)).toMatchObject({
    predecessorTaskId: fixture.source.taskId,
    predecessorName: fixture.source.name,
  });
  expect(fixture.validation).toHaveBeenCalledOnce();
  expect(readFileSync(join(fixture.sourceDirectory, 'task.json'))).toEqual(taskBytes);
  expect(readFileSync(join(fixture.sourceDirectory, 'report.json'))).toEqual(reportBytes);
  expect(readFileSync(fixture.source.nativeSessionFile)).toEqual(nativeBytes);
  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    task.taskId,
  );
});

it.each(['cleanup', 'uncertain cleanup', 'handover', 'missing native', 'out of tree'] as const)(
  'refuses native follow-up with %s',
  async (failure) => {
    const fixture = await completed();

    if (failure === 'cleanup' || failure === 'uncertain cleanup') {
      rmSync(join(fixture.sourceDirectory, 'cleanup.json'));

      if (failure === 'uncertain cleanup') {
        recordEvent(fixture.sourceDirectory, fixture.source.taskId, 'cleanup', {
          detail: 'Unknown stop.',
          stopped: false,
        });
      }
    } else if (failure === 'handover') {
      rmSync(join(fixture.sourceDirectory, 'report.json'));
    } else if (failure === 'missing native') {
      rmSync(fixture.source.nativeSessionFile);
    } else {
      fixture.input.parentSession = join(fixture.directory, 'unrelated.jsonl');
      fixture.input.parentSessionId = 'unrelated';
      writeFileSync(
        fixture.input.parentSession,
        JSON.stringify({ type: 'session', version: 3, id: 'unrelated', cwd: fixture.directory }) +
          '\n',
      );
    }

    fixture.calls.length = 0;
    expect(fixture.controller).toHaveProperty('followUp');

    await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
      /cleanup|handover|native|tree/i,
    );
    expect(fixture.calls).toEqual([]);
  },
);

it('classifies follow-up readiness deadline expiry as timeout rather than caller cancellation', async () => {
  let following = false;
  const started = Promise.withResolvers<undefined>();
  const fixture = await completed(async (argumentsList, budget, signal) => {
    if (following && argumentsList[1] === 'start') {
      started.resolve(undefined);

      return fixture.fake.client(argumentsList, budget, signal);
    }

    return '';
  });
  following = true;
  const validationDeadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(validationDeadline.signal);
  const beginning = performance.now();
  // Leave slow runners room to reach start; an early rejection fails here instead of hanging.
  const pending = fixture.controller.followUp({ ...fixture.input, timeout: 1200 }, fixture.context);
  await Promise.race([started.promise, pending]);
  validationDeadline.abort(new DOMException('Validation deadline expired.', 'TimeoutError'));
  const status = await pending;

  expect(status.outcome).toBe('timeout');
  expect(performance.now() - beginning).toBeGreaterThanOrEqual(250);
  expect(records.readEvent(status.directory, status.taskId, 'cancelled')).toBeUndefined();
  expect(records.readEvent(status.directory, status.taskId, 'timeout')).toBeDefined();
  const task = readTask(status.directory);
  expect(task.deadline - task.createdAt).toBe(1200);
});

it('allows only one competing follow-up and preserves lineage across parents and successive tasks', async () => {
  const fixture = await completed();
  const sibling = join(fixture.directory, 'sibling.jsonl');
  writeFileSync(
    sibling,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sibling',
      cwd: fixture.directory,
      parentSession: fixture.input.parentSession,
    }) + '\n',
  );
  const parallel = new WorkerController(fixture.directory, fixture.client);
  afterTest(() => {
    parallel.close();
  });
  fixture.calls.length = 0;
  const request = { ...fixture.input, parentSession: sibling, parentSessionId: 'sibling' };
  const attempts = await Promise.allSettled([
    fixture.controller.followUp(request, fixture.context),
    parallel.followUp(request, fixture.context),
  ]);
  const successes = attempts.filter((entry) => entry.status === 'fulfilled');
  expect(successes).toHaveLength(1);
  const next = successes[0]?.value;

  if (!next) {
    throw new Error('Missing winner.');
  }

  expect(fixture.calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(records.readSuccessor(fixture.sourceDirectory)?.successorTaskId).toBe(next.taskId);
  await expect(
    parallel.followUp({ ...request, sourceTaskId: next.taskId }, fixture.context),
  ).rejects.toThrow('handover');
  records.acceptReport(next.directory, next.taskId, {
    taskId: next.taskId,
    outcome: 'success',
    summary: 'Second done.',
    evidence: [],
  });
  recordEvent(next.directory, next.taskId, 'cleanup', {
    detail: 'Parent confirmed.',
    stopped: true,
  });
  fixture.controller.close();
  parallel.close();
  const latestController = new WorkerController(fixture.directory, fixture.client);
  afterTest(() => {
    latestController.close();
  });
  const latest = await latestController.followUp(
    { ...fixture.input, sourceTaskId: next.taskId },
    fixture.context,
  );
  const history = await searchHistory(
    fixture.directory,
    { file: sibling, id: 'sibling', sessionDirectory: fixture.directory },
    fixture.source.nativeSessionId,
  );

  expect(history.outcome).toBe('clarification');
  expect(history.candidates.map((candidate) => candidate.taskId)).toEqual(
    expect.arrayContaining([fixture.source.taskId, next.taskId, latest.taskId]),
  );
  expect(history.candidates).toHaveLength(3);
  expect(readTask(latest.directory).nativeSessionFile).toBe(fixture.source.nativeSessionFile);
  expect(JSON.parse(readFileSync(fixture.source.nativeSessionFile, 'utf8'))).toMatchObject({
    parentSession: fixture.source.parentSession,
  });
  await expect(latestController.followUp(fixture.input, fixture.context)).rejects.toThrow(
    next.taskId,
  );
  await expect(
    latestController.followUp({ ...fixture.input, sourceTaskId: next.taskId }, fixture.context),
  ).rejects.toThrow(latest.taskId);
});

it.each(['cancelled', 'missing after claim', 'failed startup', 'sync uncertain'] as const)(
  'releases a native claim after confirmed pre-start %s failure',
  async (failure) => {
    let following = false;
    const abort = new AbortController();
    let nativeFile = '';
    const fixture = await completed(async (argumentsList) => {
      if (following && argumentsList[1] === 'split' && failure === 'missing after claim') {
        rmSync(nativeFile);
      }

      if (following && argumentsList[1] === 'split' && failure === 'cancelled') {
        abort.abort(new Error('Caller cancelled.'));
      }

      if (following && argumentsList[1] === 'start' && failure === 'failed startup') {
        throw new Error('Uncertain start.');
      }

      return '';
    });
    nativeFile = fixture.source.nativeSessionFile;
    const nativeContents = readFileSync(nativeFile);
    following = true;

    if (failure === 'sync uncertain') {
      const claim = records.claimSuccessor;
      vi.spyOn(records, 'claimSuccessor').mockImplementation((directory, successor) => {
        claim(directory, successor);
        throw new Error('Directory sync uncertain.');
      });
    }

    const next = await fixture.controller.followUp(fixture.input, fixture.context, abort.signal);
    expect(next.outcome).toBe(failure === 'cancelled' ? 'cancelled' : 'failure');
    expect(next.state).toBe('stopped');
    expect(records.readSuccessor(fixture.sourceDirectory)).toBeUndefined();
    expect(records.readReport(next.directory, next.taskId)).toBeUndefined();
    following = false;

    if (failure === 'sync uncertain') {
      vi.mocked(records.claimSuccessor).mockRestore();
    }

    const validationFailures: unknown[] = [];

    if (failure === 'missing after claim') {
      await fixture.controller.followUp(fixture.input, fixture.context).catch((error: unknown) => {
        validationFailures.push(error);
      });
      writeFileSync(nativeFile, nativeContents);
    }

    expect(validationFailures).toHaveLength(failure === 'missing after claim' ? 1 : 0);
    const retry = await fixture.controller.followUp(fixture.input, fixture.context);

    expect(retry.state).toBe('starting');
    expect(records.readSuccessor(fixture.sourceDirectory)?.successorTaskId).toBe(retry.taskId);
  },
);

it('retains the follow-up claim when a failed start leaves an unconfirmed worker', async () => {
  const fixture = await completed();
  fixture.fake.state.startError = 'Response lost after launch';

  const failed = await fixture.controller.followUp(fixture.input, fixture.context);
  const calls = fixture.calls.length;

  expect(failed.state).toBe('cleanupUnconfirmed');
  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    failed.taskId,
  );
  expect(fixture.calls).toHaveLength(calls);
  expect(records.readSuccessor(fixture.sourceDirectory)?.successorTaskId).toBe(failed.taskId);
});

it('refuses known live native writers and preserves validation time in the original follow-up budget', async () => {
  let live: unknown[] = [];
  const fixture = await completed(async (argumentsList) =>
    argumentsList[0] === 'agent' && argumentsList[1] === 'list'
      ? JSON.stringify({ result: { type: 'agent_list', agents: live } })
      : '',
  );
  live = [
    {
      pane_id: 'manual',
      name: 'manual-pi',
      agent_session: { kind: 'path', value: fixture.source.nativeSessionFile },
    },
  ];
  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'already live',
  );
  expect(records.readSuccessor(fixture.sourceDirectory)).toBeUndefined();
  live = [];
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  fixture.validation.mockImplementation(async (value) => {
    clock.mockReturnValue(20000);

    return value as ReturnType<typeof readTask>['loadout'];
  });
  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'budget expired',
  );
  expect(fixture.calls).toEqual([]);
  expect(records.readSuccessor(fixture.sourceDirectory)).toBeUndefined();
});

it('cancels follow-up validation without claiming or launching native work', async () => {
  const fixture = await completed();
  const entered = Promise.withResolvers<undefined>();
  const abort = new AbortController();
  fixture.validation.mockImplementation(
    (_value, _context, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('Cancelled validation.', { cause: signal.reason }));
          },
          { once: true },
        );
        entered.resolve(undefined);
      }),
  );
  fixture.calls.length = 0;
  const pending = fixture.controller.followUp(fixture.input, fixture.context, abort.signal);
  await entered.promise;
  abort.abort(new Error('Cancelled validation.'));

  await expect(pending).rejects.toThrow('Cancelled validation.');
  expect(fixture.calls).toEqual([]);
  expect(records.readSuccessor(fixture.sourceDirectory)).toBeUndefined();
  expect(records.readTasks(fixture.directory)).toHaveLength(1);
});

it('retains friendly names and avoids retained and live collisions', async ({ onTestFinished }) => {
  const suffix = vi.spyOn(names, 'nameSuffix').mockReturnValue('aa');
  let live: unknown[] = [];
  const { controller, input, directory, calls } = setup(onTestFinished, 0, async (argumentsList) =>
    argumentsList[0] === 'agent' && argumentsList[1] === 'list'
      ? JSON.stringify({ result: { type: 'agent_list', agents: live } })
      : '',
  );
  const first = await controller.launch(input);
  expect(readTask(first.directory)).toMatchObject({ name: 'worker-aa' });
  recordEvent(first.directory, first.taskId, 'cleanup', {
    detail: 'Pane removed.',
    stopped: true,
  });
  live = [
    { pane_id: 'elsewhere', name: 'worker-bb' },
    { pane_id: 'unnamed', name: null },
  ];
  suffix.mockReturnValueOnce('aa').mockReturnValueOnce('bb').mockReturnValue('cc');
  const second = await controller.launch(input);

  expect(readTask(second.directory)).toMatchObject({ name: 'worker-cc' });
  expect(calls.filter((call) => call[1] === 'start').map((call) => call[2])).toEqual([
    'worker-aa',
    'worker-cc',
  ]);
  controller.close();
  const recovered = new WorkerController(directory);
  expect(recovered.status(first.taskId, input.parentSessionId)).toMatchObject({
    name: 'worker-aa',
  });
  recovered.close();
});

it('refuses admission when unreadable saved work makes tree capacity uncertain', async ({
  onTestFinished,
}) => {
  vi.spyOn(names, 'nameSuffix').mockReturnValue('aa');
  const { controller, input, directory, calls } = setup(onTestFinished);
  mkdirSync(join(directory, 'corrupt'));
  writeFileSync(join(directory, 'corrupt', 'task.json'), '{');

  await expect(controller.launch(input)).rejects.toThrow(/JSON/);

  expect(calls.filter((call) => call[1] === 'start')).toEqual([]);
});

it('bounds nested launches by the shared cap and original ancestor deadline', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished);
  vi.stubEnv('TAU_SUBAGENT_CAP', '2');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  fixture.input.loadout.tools.push('subagent');
  const parentStatus = await fixture.controller.launch(fixture.input);
  const parent = readTask(parentStatus.directory);
  recordEvent(parentStatus.directory, parent.taskId, 'accepted', 'Started.');
  const owned = records.readRecord(parentStatus.directory, 'owned.json') as {
    processId: number;
    startedAt: string;
  };
  vi.mocked(identity.currentProcessIdentity).mockResolvedValue(owned);
  vi.stubEnv('TAU_SUBAGENT_CAP', '256');
  const nested = new WorkerController(fixture.directory, fixture.client);
  onTestFinished(() => {
    nested.close();
  });
  const input = {
    ...fixture.input,
    timeout: 60000,
    parentSession: parent.nativeSessionFile,
    parentSessionId: parent.nativeSessionId,
    loadout: {
      ...parent.loadout,
      instructions: `${inheritedInstructions(parent)}Inspect the fixture.`,
    },
  };

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000);
  const childStatus = await nested.launch(input);
  const child = readTask(childStatus.directory);
  expect(child.tree.parentTaskId).toBe(parent.taskId);
  expect(child.tree.rootSessionId).toBe(parent.parentSessionId);
  expect(child.tree.monotonicDeadline).toBeLessThanOrEqual(
    parent.tree.monotonicDeadline - parent.cancellationBudget,
  );
  expect(child.deadline).toBeLessThanOrEqual(parent.deadline - parent.cancellationBudget);
  expect(child.loadout.model).toBe(parent.loadout.model);
  await expect(nested.launch(input)).rejects.toThrow('capacity full');
  expect(nested.children().active).toBe(1);
  const cancelled = await nested.cancel(child.taskId, parent.nativeSessionId);
  expect(cancelled.capacityHeld).toBe(true);
  expect(nested.children()).toMatchObject({
    active: 0,
    uncertain: [expect.stringContaining(child.taskId)],
  });
  await expect(nested.launch(input)).rejects.toThrow('capacity full');
  expect(
    fixture.controller.status(parent.taskId, fixture.input.parentSessionId).unconfirmedChildren,
  ).toEqual([{ taskId: child.taskId, directory: childStatus.directory }]);
});

it('refuses full-cap native follow-up before consuming its successor claim', async () => {
  const fixture = await completed();

  for (let index = 0; index < 4; index++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Fill the shared cap before attempting native follow-up.
    await fixture.controller.launch({ ...fixture.input, loadout: fixture.source.loadout });
  }

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'capacity full',
  );
  expect(records.readSuccessor(fixture.sourceDirectory)).toBeUndefined();
  expect(
    records
      .readTasks(fixture.directory)
      .some(({ task }) => task.predecessorTaskId === fixture.source.taskId),
  ).toBe(false);
});

it('gives the worker pane its parent process identity', async ({ onTestFinished }) => {
  const { controller, input, calls } = setup(onTestFinished);

  await controller.launch(input);

  expect(calls.find((call) => call[1] === 'split')).toContain(`TAU_PARENT_PROCESS=${process.pid}`);
});

it('reports stopped without recovery once the parent confirmed the worker stopped', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const status = await controller.launch(input);
  recordEvent(status.directory, status.taskId, 'cleanup', {
    detail: 'Owned process stopped.',
    stopped: true,
  });
  controller.close();
  const recovered = new WorkerController(directory);
  onTestFinished(() => {
    recovered.close();
  });

  const recoveredStatus = recovered.status(status.taskId, input.parentSessionId);

  expect(recoveredStatus.state).toBe('stopped');
  expect(recoveredStatus.outcome).toBe('incomplete');
  expect(recoveredStatus).not.toHaveProperty('recovery');
});

it('tells active workers when the parent controller closes', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const status = await controller.launch(input);

  controller.close();
  controller.close();

  expect(readEvent(status.directory, status.taskId, 'parentClosed')).toBeDefined();
  expect(() => controller.status(status.taskId, input.parentSessionId)).not.toThrow();
});

it('allocates distinct names for parallel launches and refuses bounded exhaustion', async ({
  onTestFinished,
}) => {
  const suffix = vi
    .spyOn(names, 'nameSuffix')
    .mockReturnValueOnce('aa')
    .mockReturnValueOnce('aa')
    .mockReturnValue('bb');
  const { controller, client, directory, input, calls } = setup(onTestFinished);
  const parallel = new WorkerController(directory, client);
  onTestFinished(() => {
    parallel.close();
  });
  const launched = await Promise.all([controller.launch(input), parallel.launch(input)]);
  expect(
    launched
      .map((status) => readTask(status.directory).name)
      .toSorted((left, right) => String(left).localeCompare(String(right))),
  ).toEqual(['worker-aa', 'worker-bb']);
  suffix.mockClear().mockReturnValue('aa');
  const starts = calls.filter((call) => call[1] === 'start').length;

  await expect(controller.launch(input)).rejects.toThrow('32');
  expect(suffix).toHaveBeenCalledTimes(32);
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(starts);
});

it.each(['failure', 'malformed'] as const)(
  'refuses naming when live listing is %s',
  async (kind) => {
    const { controller, input, calls } = setup(afterTest, 0, async (argumentsList) => {
      if (argumentsList[1] !== 'list') {
        return '';
      }

      if (kind === 'failure') {
        throw new Error('Listing failed.');
      }

      return JSON.stringify({
        result: { type: 'agent_list', agents: [{ pane_id: 'other', name: 42 }] },
      });
    });

    await expect(controller.launch(input)).rejects.toThrow(/listing|Listing/);
    expect(calls.some((call) => call[1] === 'split')).toBe(false);
  },
);

it.each(['cancelled', 'expired', 'closed'] as const)(
  'keeps naming inside the original launch budget when %s',
  async (kind) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const listed = Promise.withResolvers<number>();
    const release = Promise.withResolvers<string>();
    const abort = new AbortController();
    const { controller, input, calls, directory } = setup(
      afterTest,
      0,
      async (argumentsList, budget) => {
        if (argumentsList[1] === 'list') {
          listed.resolve(budget);

          return release.promise;
        }

        return '';
      },
    );
    const pending = controller.launch(input, abort.signal);
    expect(await listed.promise).toBeLessThanOrEqual(7500);

    if (kind === 'cancelled') {
      abort.abort(new Error('Name listing cancelled.'));
    } else if (kind === 'closed') {
      controller.close();
    } else {
      clock.mockReturnValue(10000);
    }

    release.resolve(JSON.stringify({ result: { type: 'agent_list', agents: [] } }));

    await expect(pending).rejects.toThrow(/cancelled|aborted|budget expired/);
    expect(calls.map((call) => call[1])).toEqual(['list']);
    expect(readdirSync(directory)).toEqual(['parent.jsonl']);
  },
);

it('retains the chosen name but never retries a late live collision', async ({
  onTestFinished,
}) => {
  vi.spyOn(names, 'nameSuffix').mockReturnValue('xy');
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'start') {
      throw new Error('agent_name_taken');
    }

    return '';
  });
  const status = await controller.launch({
    ...input,
    loadout: { ...input.loadout, role: 'investigation' },
  });

  expect(status).toMatchObject({
    name: 'investigator-xy',
    outcome: 'failure',
    capacityHeld: false,
  });
  expect(controller.children()).toEqual({ active: 0, uncertain: [] });
  expect(readTask(status.directory).name).toBe('investigator-xy');
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(calls.some((call) => ['prompt', 'send-keys'].includes(call[1] ?? ''))).toBe(false);
});

it('delivers a clarification once without treating herdr delivery as acknowledgement', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, input, calls, notifications, directory } = setup(
    onTestFinished,
    0,
    async (argumentsList) => (argumentsList[1] === 'prompt' ? JSON.stringify({ result: {} }) : ''),
  );
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');
  const question = {
    version: 1,
    taskId: task.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  };
  questions.acceptQuestion(launched.directory, task.taskId, question);

  expect(controller).toHaveProperty('reply');
  expect(controller.status(task.taskId, 'parent-id').pendingQuestion).toEqual(question);
  const answer = {
    questionId: question.questionId,
    replyId: 'reply-one',
    reply: 'source.txt',
    scopeUnchanged: true,
  };
  await expect(controller.reply(task.taskId, 'wrong-parent', answer)).rejects.toThrow(
    'another parent',
  );
  await expect(
    controller.reply(task.taskId, 'parent-id', { ...answer, scopeUnchanged: false }),
  ).rejects.toThrow('scope');
  await expect(
    controller.reply(task.taskId, 'parent-id', { ...answer, questionId: 'wrong' }),
  ).rejects.toThrow('pending question');
  const result = await controller.reply(task.taskId, 'parent-id', answer);
  expect(result).toMatchObject({ replyAccepted: true });
  expect(result).toMatchObject({ workerAcknowledged: false });
  expect(result).toMatchObject({ name: task.name });
  await controller.reply(task.taskId, 'parent-id', answer);
  expect(calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
  expect(calls.find((call) => call[1] === 'prompt')?.[2]).toBe('worker-1');
  expect(records.readTask(launched.directory)).toEqual(task);
  expect(
    questions.readAcknowledgement(launched.directory, task.taskId, question.questionId),
  ).toBeUndefined();
  expect(notifications).toEqual([]);

  controller.close();
  const recovered = new WorkerController(directory);
  expect(recovered.status(task.taskId, 'parent-id').pendingQuestion).toEqual({
    ...question,
    replySaved: true,
  });
  await expect(recovered.reply(task.taskId, 'parent-id', answer)).rejects.toThrow('active');
  recovered.close();
});

it('treats an unreadable acknowledgement as unacknowledged after saving the Pi reply', async ({
  onTestFinished,
}) => {
  let taskDirectory = '';
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'prompt') {
      writeFileSync(join(taskDirectory, 'acknowledgement-question-one.json'), '{}');

      return JSON.stringify({ result: {} });
    }

    return '';
  });
  const launched = await controller.launch(input);
  taskDirectory = launched.directory;
  const task = readTask(launched.directory);
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');
  questions.acceptQuestion(launched.directory, task.taskId, {
    version: 1,
    taskId: task.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  const result = await controller.reply(task.taskId, 'parent-id', {
    questionId: 'question-one',
    replyId: 'reply-one',
    reply: 'source.txt',
    scopeUnchanged: true,
  });

  expect(result).toMatchObject({
    replyAccepted: true,
    workerAcknowledged: false,
    delivery: 'sent',
  });
  expect(calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
});

it('treats an unreadable acknowledgement as unacknowledged on a repeated Pi reply', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) =>
    argumentsList[1] === 'prompt' ? JSON.stringify({ result: {} }) : '',
  );
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');
  questions.acceptQuestion(launched.directory, task.taskId, {
    version: 1,
    taskId: task.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });
  const answer = {
    questionId: 'question-one',
    replyId: 'reply-one',
    reply: 'source.txt',
    scopeUnchanged: true,
  };
  await controller.reply(task.taskId, 'parent-id', answer);
  writeFileSync(join(launched.directory, 'acknowledgement-question-one.json'), '{}');

  const repeated = await controller.reply(task.taskId, 'parent-id', answer);

  expect(repeated).toMatchObject({
    replyAccepted: true,
    workerAcknowledged: false,
    delivery: 'notResent',
  });
  expect(calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
});

it.each(['before', 'during'] as const)(
  'checks terminal movement %s reply identity checks',
  async (movement) => {
    let replying = false;
    let moved = false;
    let token = '';
    const movedPane = 'other-workspace:worker';
    const { controller, input, calls } = setup(afterTest, 0, async (argumentsList) => {
      if (argumentsList[1] === 'start') {
        token = argumentsList[argumentsList.indexOf('--session') + 1]!;
      }

      if (!replying) {
        return '';
      }

      if (argumentsList[0] === 'pane' && argumentsList[1] === 'list' && moved) {
        return JSON.stringify({
          result: {
            panes: [
              {
                pane_id: movedPane,
                terminal_id: 'terminal-1',
                workspace_id: 'other-workspace',
                tab_id: 'other-tab',
              },
            ],
          },
        });
      }

      if (argumentsList[1] === 'process-info' && moved) {
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: movedPane,
              shell_pid: 100,
              foreground_process_group_id: process.pid,
              foreground_processes: [{ pid: process.pid, argv: ['pi', token] }],
            },
          },
        });
      }

      if (argumentsList[1] === 'get') {
        const paneId = moved ? movedPane : 'worker-1';
        moved = true;

        return JSON.stringify({
          result: { agent: { pane_id: paneId, agent: 'pi', agent_session: { value: token } } },
        });
      }

      if (argumentsList[1] === 'prompt') {
        return '{}';
      }

      return '';
    });
    const launched = await controller.launch(input);
    recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
    questions.acceptQuestion(launched.directory, launched.taskId, {
      version: 1,
      taskId: launched.taskId,
      questionId: 'question-one',
      question: 'Which file?',
    });
    replying = true;
    moved = movement === 'before';
    const reply = controller.reply(launched.taskId, 'parent-id', {
      questionId: 'question-one',
      replyId: 'reply-one',
      reply: 'source.txt',
      scopeUnchanged: true,
    });

    const outcome = await reply.catch((error: unknown) => String(error));

    const expected: Record<typeof movement, unknown> = {
      before: expect.objectContaining({ replyAccepted: true, workerAcknowledged: false }),
      during: expect.stringContaining('moved'),
    };
    expect(outcome).toEqual(expected[movement]);
    expect(calls.filter((call) => call[1] === 'prompt').map((call) => call[2])).toEqual(
      movement === 'before' ? [movedPane] : [],
    );
    expect(questions.readReply(launched.directory, launched.taskId, 'question-one')?.replyId).toBe(
      movement === 'before' ? 'reply-one' : undefined,
    );
  },
);

it('retains uncertain reply delivery without resending or acknowledging it', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished);
  const launched = await controller.launch(input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });
  const answer = {
    questionId: 'question-one',
    replyId: 'reply-one',
    reply: 'source.txt',
    scopeUnchanged: true,
  };

  const uncertain = await controller.reply(launched.taskId, 'parent-id', answer);

  expect(uncertain).toMatchObject({ replyAccepted: true, delivery: 'uncertain' });
  expect(uncertain).toHaveProperty(
    'deliveryError',
    expect.stringContaining('Injected herdr failure'),
  );
  await expect(controller.reply(launched.taskId, 'parent-id', answer)).resolves.toMatchObject({
    workerAcknowledged: false,
    delivery: 'notResent',
  });
  expect(calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
  expect(controller.questionReceipt(launched.taskId, 'parent-id', 'question-one')).toMatchObject({
    reply: { replyId: 'reply-one' },
    acknowledgement: undefined,
  });
  await expect(
    controller.reply(launched.taskId, 'parent-id', { ...answer, reply: 'changed' }),
  ).rejects.toThrow('Conflicting');
});

it('notifies the parent once while waiting and refuses replies after the original deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, input, notifications, calls } = setup(onTestFinished);
  const launched = await controller.launch(input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  await vi.advanceTimersByTimeAsync(500);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.content).toMatchObject({
    state: 'awaitingReply',
    pendingQuestion: { questionId: 'question-one', question: 'Which file?' },
  });
  expect(notifications[0]?.question).toBe(true);
  expect(controller.status(launched.taskId, 'parent-id').deadline).toBe(launched.deadline);
  await vi.advanceTimersByTimeAsync(7500);
  await expect(
    controller.reply(launched.taskId, 'parent-id', {
      questionId: 'question-one',
      replyId: 'reply-one',
      reply: 'source.txt',
      scopeUnchanged: true,
    }),
  ).rejects.toThrow('active');
  expect(calls.some((call) => call[1] === 'prompt')).toBe(false);
  expect(questions.readReply(launched.directory, launched.taskId, 'question-one')).toBeUndefined();
});

it('refuses reply delivery when the original native worker identity changes', async ({
  onTestFinished,
}) => {
  let changed = false;
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) =>
    changed && argumentsList[1] === 'get'
      ? JSON.stringify({
          result: {
            agent: { pane_id: 'worker-1', agent: 'pi', agent_session: { value: '/wrong.jsonl' } },
          },
        })
      : '',
  );
  const launched = await controller.launch(input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });
  changed = true;

  await expect(
    controller.reply(launched.taskId, 'parent-id', {
      questionId: 'question-one',
      replyId: 'reply-one',
      reply: 'source.txt',
      scopeUnchanged: true,
    }),
  ).rejects.toThrow('identity');
  expect(calls.some((call) => call[1] === 'prompt')).toBe(false);
  expect(questions.readReply(launched.directory, launched.taskId, 'question-one')).toBeUndefined();
});

it('waits for Pi integration session identity before dispatch', async ({ onTestFinished }) => {
  let missingSessionResponses = 0;
  const fixture = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'get' && missingSessionResponses < 2) {
      missingSessionResponses += 1;

      return JSON.stringify({
        result: { agent: { pane_id: argumentsList[2], agent: 'pi', agent_session: null } },
      });
    }

    return '';
  });

  const launched = await fixture.controller.launch(fixture.input);

  expect(launched.state).toBe('starting');
  expect(readFileSync(join(launched.directory, 'dispatch.json'), 'utf8')).toContain(
    launched.taskId,
  );
  expect(missingSessionResponses).toBe(2);
});

it("names herdr's Pi integration when a started Pi worker reports no agent session", async ({
  onTestFinished,
}) => {
  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    0,
    async (argumentsList) =>
      argumentsList[0] === 'agent' && argumentsList[1] === 'get'
        ? JSON.stringify({ result: { agent: { pane_id: 'owned-pane', agent: 'pi' } } })
        : '',
  );

  const launched = await controller.launch(input);

  expect(launched.outcome).toBe('failure');
  expect(launched.failure).toContain("herdr's Pi integration");
  expect(launched.failure).toContain('herdr integration install pi');
  expect(JSON.stringify(notifications)).toContain("herdr's Pi integration");
  expect(JSON.stringify(notifications)).toContain('herdr integration install pi');
  expect(calls.some((call) => call[1] === 'prompt')).toBe(false);
});

it.each(['confirmed', 'unconfirmed'] as const)(
  'preserves foreground sharing during %s cleanup and releases ownership afterward',
  async (outcome) => {
    const terminal = placementFixture(250, 30);
    const tokens = new Map<string, string>();
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const release = vi.spyOn(WorkerPlacement.prototype, 'release');
    let cleaning = false;
    let held = false;
    const { controller, input } = setup(afterTest, 0, async (argumentsList) => {
      if (cleaning && !held && argumentsList[1] === 'list') {
        held = true;
        entered.resolve(undefined);
        await resume.promise;

        if (outcome === 'unconfirmed') {
          throw new Error('Cleanup identity unavailable.');
        }
      }

      const paneId = argumentsList[argumentsList.indexOf('--pane') + 1]!;

      if (argumentsList[1] === 'start') {
        const token = argumentsList[argumentsList.indexOf('--session') + 1]!;
        tokens.set(paneId, token);
        const task = readTask(dirname(token));
        recordEvent(dirname(token), task.taskId, 'ready', {
          detail: 'Ready.',
          processId: process.pid,
        });

        return '{}';
      }

      if (argumentsList[1] === 'process-info') {
        const stopped = cleaning && paneId === 'worker-1';
        const shellForeground = stopped || !tokens.has(paneId);
        const foregroundProcess = shellForeground ? 100 : process.pid;

        return JSON.stringify({
          result: {
            process_info: {
              pane_id: paneId,
              shell_pid: 100,
              foreground_process_group_id: foregroundProcess,
              foreground_processes: [{ pid: foregroundProcess, argv: ['pi', tokens.get(paneId)] }],
            },
          },
        });
      }

      if (argumentsList[1] === 'get') {
        return JSON.stringify({
          result: {
            agent: {
              pane_id: argumentsList[2],
              agent: 'pi',
              agent_session: { value: tokens.get(argumentsList[2]!) },
            },
          },
        });
      }

      if (argumentsList[0] === 'agent' && argumentsList[1] === 'list') {
        return '';
      }

      return terminal.client(argumentsList);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = await controller.launch(input);
    expect(first.state).toBe('starting');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    });
    cleaning = true;
    const cancellation = controller.cancel(first.taskId, input.parentSessionId);
    await entered.promise;

    try {
      const second = await controller.launch(input);
      expect(second.state).toBe('starting');
      expect(terminal.panes.map((pane) => pane.tab_id)).toEqual(['working', 'working', 'working']);
      expect(terminal.calls.some((call) => call[1] === 'create')).toBe(false);
      expect(release).not.toHaveBeenCalledWith('terminal-1');
    } finally {
      resume.resolve(undefined);
      await cancellation;
    }

    expect(release).toHaveBeenCalledWith('terminal-1');
    expect(terminal.panes.some((pane) => pane.pane_id === 'worker-1')).toBe(
      outcome === 'unconfirmed',
    );
  },
);

it('chooses a down split for a narrow tall parent without changing focus', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'current') {
      return JSON.stringify({
        result: {
          pane: {
            pane_id: 'parent',
            terminal_id: 'parent-terminal',
            workspace_id: 'workspace',
            tab_id: 'tab',
          },
        },
      });
    }

    if (argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
      return JSON.stringify({
        result: {
          panes: [
            {
              pane_id: 'parent',
              terminal_id: 'parent-terminal',
              workspace_id: 'workspace',
              tab_id: 'tab',
            },
            {
              pane_id: 'worker-1',
              terminal_id: 'terminal-1',
              workspace_id: 'workspace',
              tab_id: 'tab',
            },
          ],
        },
      });
    }

    if (argumentsList[1] === 'layout') {
      return JSON.stringify({
        result: {
          layout: {
            workspace_id: 'workspace',
            tab_id: 'tab',
            zoomed: false,
            area: { width: 100, height: 90 },
            panes: [{ pane_id: 'parent', rect: { width: 100, height: 90 } }],
          },
        },
      });
    }

    return '';
  });
  const launched = await controller.launch(input);

  expect(launched.failure).toBeUndefined();
  expect(calls.find((call) => call[1] === 'split')).toEqual(
    expect.arrayContaining(['--direction', 'down', '--no-focus']),
  );
  expect(calls.some((call) => call[1] === 'resize' || call[1] === 'focus')).toBe(false);
});

it.each(['moved', 'duplicate', 'missing', 'replacement job'] as const)(
  'protects terminal ownership during %s cleanup',
  async (scenario) => {
    let cleaning = false;
    const { controller, input, calls } = setup(afterTest, 0, async (argumentsList) => {
      if (!cleaning) {
        return '';
      }

      if (argumentsList[1] === 'list') {
        const pane = {
          pane_id: 'other-workspace:pane',
          terminal_id: 'terminal-1',
          workspace_id: 'other-workspace',
          tab_id: 'other-workspace:tab',
        };
        const panes = scenario === 'missing' ? [] : [pane];

        if (scenario === 'duplicate') {
          panes.push({ ...pane, pane_id: 'ambiguous' });
        }

        return JSON.stringify({ result: { panes } });
      }

      if (argumentsList[1] === 'process-info') {
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: 'other-workspace:pane',
              shell_pid: 100,
              foreground_process_group_id: scenario === 'replacement job' ? 987 : 100,
              foreground_processes: [],
            },
          },
        });
      }

      if (argumentsList[1] === 'close') {
        return '{}';
      }

      return '';
    });
    const launched = await controller.launch(input);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    });
    cleaning = true;
    const previousCalls = calls.length;
    const cancelled = await controller.cancel(launched.taskId, 'parent-id');
    const cleanupCalls = calls.slice(previousCalls);

    expect(cleanupCalls.filter((call) => call[1] === 'close')).toEqual(
      scenario === 'moved' ? [['pane', 'close', 'other-workspace:pane']] : [],
    );
    expect(cleanupCalls.some((call) => call[1] === 'send-keys')).toBe(false);
    expect(cleanupCalls.flat()).not.toContain('worker-1');
    expect(cancelled.state).toBe(scenario === 'moved' ? 'stopped' : 'cleanupUnconfirmed');
    expect(cancelled.deadline).toBe(launched.deadline);
  },
);

it('retains confirmed terminal evidence when cancelled during the cosmetic placement snapshot', async ({
  onTestFinished,
}) => {
  const abort = new AbortController();
  const snapshot = Promise.withResolvers<undefined>();
  let created = false;
  let recordDirectory = '';
  const release = vi.spyOn(WorkerPlacement.prototype, 'release');
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'split') {
      created = true;
      recordDirectory = argumentsList
        .find((argument) => argument.startsWith('TAU_WORKER_RECORD='))!
        .slice('TAU_WORKER_RECORD='.length);
    } else if (created && argumentsList[1] === 'layout') {
      abort.abort();
      await snapshot.promise;
    }

    return '';
  });
  const status = await controller.launch(input, abort.signal);
  const evidence = readdirSync(recordDirectory);
  snapshot.resolve(undefined);

  expect(evidence).toContain('pane.json');
  expect(JSON.parse(readFileSync(join(recordDirectory, 'pane.json'), 'utf8'))).toMatchObject({
    paneId: 'worker-1',
    terminalId: 'terminal-1',
  });
  expect(status).toMatchObject({
    outcome: 'cancelled',
    state: 'stopped',
    capacityHeld: false,
  });
  expect(status.cleanup).toContain('worker-1');
  expect(release).toHaveBeenCalledWith('terminal-1');
  expect(calls.some((call) => ['start', 'close', 'send-keys'].includes(call[1]!))).toBe(false);
});

it('rejects aggregate Unicode tasks before publishing records or creating a pane', async ({
  onTestFinished,
}) => {
  const { directory, controller, input, calls } = setup(onTestFinished);
  const task = '界'.repeat(32_000);
  const loadout = { ...input.loadout, instructions: '界'.repeat(32_000) };

  await expect(controller.launch({ ...input, task, loadout })).rejects.toThrow(
    'Worker record exceeds 128 KB.',
  );
  expect(calls).toEqual([]);
  const directories = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(directories).toHaveLength(0);
  expect(directories.map((name) => readdirSync(join(directory, name)))).toEqual([]);
});

it('launches a fresh worker with saved full-tool settings and recovers without resubmission', async ({
  onTestFinished,
}) => {
  const { directory, controller, calls, input } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  const header: unknown = JSON.parse(readFileSync(task.nativeSessionFile, 'utf8'));

  expect(header).toMatchObject({
    parentSession: input.parentSession,
    id: task.nativeSessionId,
    type: 'session',
  });
  expect(task.nativeSessionId).not.toBe(task.taskId);
  expect(task.loadout).toEqual(input.loadout);
  expect(workerArguments(task).slice(3, 9)).toEqual([
    '--provider',
    'faux',
    '--model',
    'test',
    '--thinking',
    'off',
  ]);
  expect(workerArguments(task)).toContain('--no-extensions');
  expect(workerArguments(task)).toContain(input.loadout.safetyExtension);
  expect(launched.state).toBe('starting');
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');
  acceptReport(launched.directory, task.taskId, {
    taskId: task.taskId,
    outcome: 'success',
    summary: 'Edited fixture.',
    evidence: ['test passed'],
  });

  expect(controller.status(task.taskId, 'parent-id')).toMatchObject({
    state: 'reported',
    outcome: 'success',
    deadline: task.deadline,
  });
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(calls.find((call) => call[1] === 'start')?.[2]).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  controller.close();
  const recovered = new WorkerController(directory);
  onTestFinished(() => {
    recovered.close();
  });
  expect(recovered.status(task.taskId, 'parent-id')).toMatchObject({
    state: 'notOwned',
    recovery: {
      paneId: 'worker-1',
      directory: launched.directory,
      nativeSessionFile: task.nativeSessionFile,
    },
  });
  expect(recovered.status(task.taskId, 'parent-id').report?.summary).toBe('Edited fixture.');
  expect(() => recovered.status(task.taskId, 'wrong-parent')).toThrow('another parent');

  for (const [taskId, parentSessionId] of [
    [task.taskId, 'wrong-parent'],
    ['missing-task', 'parent-id'],
    ['../escape', 'parent-id'],
  ] as const) {
    let refusal: unknown = null;

    try {
      recovered.status(taskId, parentSessionId);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(EvidenceUnavailableError);
    expect(String(refusal)).not.toContain(dirname(launched.directory));
  }

  await expect(recovered.cancel(task.taskId, 'parent-id')).rejects.toThrow('manual cleanup');
});

it('recovers reports and native references without extension discovery metadata', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  acceptReport(launched.directory, task.taskId, {
    taskId: task.taskId,
    outcome: 'success',
    summary: 'Saved HEAD handover.',
    evidence: ['existing evidence'],
  });
  controller.close();
  const recovered = new WorkerController(directory);
  onTestFinished(() => {
    recovered.close();
  });

  expect(recovered.status(task.taskId, 'parent-id')).toMatchObject({
    outcome: 'success',
    state: 'notOwned',
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    report: { summary: 'Saved HEAD handover.' },
  });
  expect(workerArguments(readTask(launched.directory))).toContain('--no-extensions');
  expect(workerArguments(readTask(launched.directory))).toContain(task.loadout.safetyExtension);
});

it('stops dispatched work when the launch status finds corrupt report evidence', async ({
  onTestFinished,
}) => {
  let recordDirectory = '';
  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    0,
    async (argumentsList) => {
      if (argumentsList[1] === 'start') {
        recordDirectory = dirname(argumentsList[argumentsList.indexOf('--session') + 1] ?? '');
        writeFileSync(join(recordDirectory, 'report.json'), '{');
      }

      return '';
    },
  );

  await expect(controller.launch(input)).rejects.toThrow('saved evidence is unavailable');
  expect(readdirSync(recordDirectory)).toContain('dispatch.json');
  await vi.waitFor(() => {
    expect(notifications).toHaveLength(1);
  });
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(JSON.stringify(notifications[0]?.content)).toContain('worker-1');
  expect(readFileSync(join(recordDirectory, 'report.json'), 'utf8')).toBe('{');
});

it('only lets the owning parent stop work after a status evidence failure', async ({
  onTestFinished,
}) => {
  const { controller, input, calls, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  writeFileSync(join(launched.directory, 'report.json'), '{');

  const callCount = calls.length;
  expect(() => controller.status(launched.taskId, 'another-parent')).toThrow(
    'another parent session',
  );
  expect(calls).toHaveLength(callCount);
  expect(() => controller.status(launched.taskId, 'parent-id')).toThrow(
    'saved evidence is unavailable',
  );
  let evidenceError = '';

  try {
    controller.status(launched.taskId, 'parent-id');
  } catch (error) {
    evidenceError = String(error);
  }

  expect(evidenceError).not.toContain(launched.nativeSessionFile);
  let evidenceFailure: unknown;

  try {
    controller.status(launched.taskId, 'parent-id');
  } catch (error) {
    evidenceFailure = error;
  }

  expect(evidenceFailure).toBeInstanceOf(EvidenceUnavailableError);
  expect((evidenceFailure as EvidenceUnavailableError).recovery).toMatchObject({
    directory: launched.directory,
    nativeSessionFile: launched.nativeSessionFile,
  });
  expect((evidenceFailure as Error).message).not.toContain(launched.directory);
  await vi.waitFor(() => {
    expect(notifications).toHaveLength(1);
  });
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(JSON.stringify(notifications[0]?.content)).toContain(launched.nativeSessionId);
});

it('keeps the original deadline and reports active-work cancellation failure honestly', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, calls, input, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  await vi.advanceTimersByTimeAsync(5000);
  expect(controller.status(launched.taskId, 'parent-id').deadline).toBe(launched.deadline);
  vi.setSystemTime(Date.now() - 60_000);
  await vi.advanceTimersByTimeAsync(2600);
  await controller.cancel(launched.taskId, 'parent-id');
  const status = controller.status(launched.taskId, 'parent-id');

  expect(status.outcome).toBe('timeout');
  expect(status.state).toBe('cleanupUnconfirmed');
  expect(status.recovery?.paneId).toBe('worker-1');
  expect(status.cleanup).toContain('manual cleanup');
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(calls.some((call) => call[1] === 'close')).toBe(false);
  expect(notifications).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(notifications).toHaveLength(1);
});

it('preserves incomplete output and malformed evidence without retrying startup', async ({
  onTestFinished,
}) => {
  const { directory, input } = setup(onTestFinished);
  const calls: string[][] = [];
  const controller = new WorkerController(directory, async (argumentsList) => {
    calls.push(argumentsList);

    if (argumentsList[1] === 'list') {
      return JSON.stringify({ result: { type: 'agent_list', agents: [] } });
    }

    throw new Error('Startup unavailable');
  });
  onTestFinished(() => {
    controller.close();
  });
  const status = await controller.launch(input);

  expect(status).toMatchObject({
    outcome: 'failure',
    state: 'stopped',
    capacityHeld: false,
  });
  expect(calls.map((call) => call[1])).toEqual(['list', 'current']);
  expect(readdirSync(status.directory)).toContain('task.json');
  writeFileSync(join(status.directory, 'report.json'), '{');
  expect(() => taskStatus(status.directory)).toThrow(/JSON|property/);
});

it('distinguishes settled missing handover and cancellation from success', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);
  recordEvent(launched.directory, launched.taskId, 'settled', {
    detail: 'Stopped without report.',
    stopped: true,
  });

  expect(taskStatus(launched.directory)).toMatchObject({
    outcome: 'incomplete',
    state: 'cleanupUnconfirmed',
  });
  const cancelled = await controller.cancel(launched.taskId, 'parent-id');
  expect(cancelled.outcome).toBe('cancelled');
});

it('includes prior loadout resolution in the original task deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, input } = setup(onTestFinished);
  const startedAt = { wall: Date.now() - 4000, monotonic: performance.now() - 4000 };
  const launched = await controller.launch({ ...input, startedAt });

  expect(launched.deadline).toBe(startedAt.wall + input.timeout);
  await vi.advanceTimersByTimeAsync(3600);
  await controller.cancel(launched.taskId, 'parent-id');
  expect(controller.status(launched.taskId, 'parent-id').outcome).toBe('timeout');
});

it('waits for an in-flight start before confirming shutdown cleanup', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const fixture = setup(onTestFinished, -1);
  const processStart = await originalRunClient(
    'ps',
    ['-p', String(process.pid), '-o', 'lstart='],
    1000,
  );
  vi.spyOn(cancellationModule, 'runClient').mockResolvedValue(processStart);
  fixture.fake.state.sendKeysError = '';
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (fixture.fake.state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }

    return true;
  });
  const enteredStart = Promise.withResolvers<undefined>();
  const client = fixture.fake.client;
  vi.spyOn(fixture.fake, 'client').mockImplementation(async (argumentsList, budget, signal) => {
    if (argumentsList[1] === 'start') {
      enteredStart.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await client(argumentsList, budget, signal);
      await new Promise((resolve) => setTimeout(resolve, 40));
      throw new Error('Start response lost after server launched Pi');
    }

    if (argumentsList[1] === 'get' && !fixture.fake.state.started) {
      const missing = await client(argumentsList, budget, signal).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw missing;
    }

    return client(argumentsList, budget, signal);
  });
  const launching = fixture.controller.launch(fixture.input);
  await enteredStart.promise;
  const shutdown = fixture.controller.stopAll('reload');
  await vi.advanceTimersByTimeAsync(100);
  await shutdown;
  const launched = await launching;

  expect(fixture.fake.state.stopped).toBe(true);
  expect(launched.capacityHeld).toBe(false);
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
  expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
});

it('refuses a prepared launch while shutdown is still draining workers', async ({
  onTestFinished,
}) => {
  const listingEntered = Promise.withResolvers<undefined>();
  const releaseListing = Promise.withResolvers<undefined>();
  const cleanupEntered = Promise.withResolvers<undefined>();
  const releaseCleanup = Promise.withResolvers<undefined>();
  let pauseListing = false;
  let pauseCleanup = false;
  const fixture = setup(onTestFinished, 0, async (argumentsList) => {
    if (pauseListing && argumentsList[0] === 'agent' && argumentsList[1] === 'list') {
      pauseListing = false;
      listingEntered.resolve(undefined);
      await releaseListing.promise;
    }

    if (pauseCleanup && argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
      pauseCleanup = false;
      cleanupEntered.resolve(undefined);
      await releaseCleanup.promise;
    }

    return '';
  });
  onTestFinished(() => {
    releaseListing.resolve(undefined);
    releaseCleanup.resolve(undefined);
  });
  await fixture.controller.launch(fixture.input);
  const recordsBefore = readdirSync(fixture.directory);
  const panesBefore = structuredClone(fixture.fake.layout.panes);
  pauseListing = true;
  const launching = fixture.controller.launch(fixture.input).catch((error: unknown) => error);
  await listingEntered.promise;
  pauseCleanup = true;
  const shutdown = fixture.controller.stopAll('reload');
  await cleanupEntered.promise;
  releaseListing.resolve(undefined);
  const launchResult = await launching;
  const recordsAfter = readdirSync(fixture.directory);
  const panesAfter = structuredClone(fixture.fake.layout.panes);
  releaseCleanup.resolve(undefined);
  await shutdown;

  expect(launchResult).toBeInstanceOf(Error);
  expect(String(launchResult)).toContain('Parent controller stopped');
  expect(recordsAfter).toEqual(recordsBefore);
  expect(panesAfter).toEqual(panesBefore);
  expect(fixture.calls.filter((call) => call[1] === 'start')).toHaveLength(1);
});

it('stops running workers and frees their slots on reload', async ({ onTestFinished }) => {
  const fixture = setup(onTestFinished);
  fixture.fake.state.sendKeysError = '';
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (fixture.fake.state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }

    return true;
  });
  const launched = await fixture.controller.launch(fixture.input);

  await fixture.controller.stopAll('reload');

  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.detail).toContain(
    'Parent session reload',
  );
  expect(fixture.controller.status(launched.taskId, fixture.input.parentSessionId).state).toBe(
    'stopped',
  );
  expect(fixture.controller.children()).toEqual({ active: 0, uncertain: [] });
  expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
  await expect(fixture.controller.launch(fixture.input)).rejects.toThrow(
    'Parent controller stopped',
  );
});

it('bounds reload cleanup by the remaining cancellation budget', async ({ onTestFinished }) => {
  let cleaning = false;
  const fixture = setup(onTestFinished, 0, async (argumentsList, _budget, signal) => {
    if (cleaning && argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('Cleanup deadline reached'));
          },
          { once: true },
        );
      });
    }

    return '';
  });
  const launched = await fixture.controller.launch({ ...fixture.input, timeout: 1200 });
  cleaning = true;
  const began = performance.now();

  await fixture.controller.stopAll('reload');

  expect(performance.now() - began).toBeLessThan(1000);
  const cleanup = readEvent(launched.directory, launched.taskId, 'cleanup');
  expect(cleanup?.stopped).toBe(false);
  expect(cleanup?.detail).toContain('Parent session reload');
  expect(
    fixture.controller.status(launched.taskId, fixture.input.parentSessionId).capacityHeld,
  ).toBe(true);
});

it('ends enforcement on parent shutdown without claiming cleanup', async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const { controller, calls, input, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const callCount = calls.length;

  controller.close();
  await vi.advanceTimersByTimeAsync(20_000);

  const status = controller.status(launched.taskId, 'parent-id');
  expect(status.state).toBe('notOwned');
  expect(status).not.toHaveProperty('outcome');
  expect(calls).toHaveLength(callCount);
  expect(notifications).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('ends in-flight cleanup on parent shutdown without further calls or notification', async ({
  onTestFinished,
}) => {
  const entered = Promise.withResolvers<AbortSignal>();
  const released = Promise.withResolvers<string>();
  let cleaning = false;
  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    0,
    async (_arguments, _budget, signal) => {
      if (!cleaning || !signal) {
        return '';
      }

      entered.resolve(signal);

      return released.promise;
    },
  );
  const launched = await controller.launch(input);
  cleaning = true;
  const cancellation = controller.cancel(launched.taskId, 'parent-id');
  const signal = await entered.promise;
  const callCount = calls.length;

  controller.close();
  const abortedOnClose = signal.aborted;
  released.resolve(JSON.stringify({ result: { process_info: {} } }));
  await cancellation;

  expect(abortedOnClose).toBe(true);
  expect(calls).toHaveLength(callCount);
  expect(notifications).toEqual([]);
  expect(readdirSync(launched.directory)).not.toContain('notified.json');
  expect(controller.status(launched.taskId, 'parent-id')).toMatchObject({
    outcome: 'cancelled',
    state: 'cleanupUnconfirmed',
  });
  expect(controller.status(launched.taskId, 'parent-id').cleanup).toContain('manually');
});

it('refuses expired work and invalid deadlines before creating a pane', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished);
  const startedAt = {
    wall: Date.now() - input.timeout,
    monotonic: performance.now() - input.timeout,
  };

  await expect(controller.launch({ ...input, startedAt })).rejects.toThrow('work budget expired');

  for (const timeout of [0, -1, Number.NaN, 2_147_483_648]) {
    await expect(controller.launch({ ...input, timeout })).rejects.toThrow(
      /work budget expired|Invalid fixed worker deadline/,
    );
  }

  expect(calls).toEqual([]);
});

it('rejects invalid model and thinking in saved loadouts without replacing the task', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const path = join(launched.directory, 'task.json');
  const task = readTask(launched.directory);

  for (const invalid of [{ model: 'missing-provider' }, { thinking: 'invalid' }]) {
    writeFileSync(path, JSON.stringify({ ...task, loadout: { ...task.loadout, ...invalid } }));
    expect(() => readTask(launched.directory)).toThrow('Invalid saved worker task or loadout');
  }

  writeFileSync(path, JSON.stringify(task));
  expect(readTask(launched.directory).loadout).toEqual(input.loadout);
});

it.each([true, false])(
  'preserves uncertain launch ownership when process inspection fails with absent process %s',
  async (absent) => {
    const { controller, input, calls } = setup(afterTest, -1);
    vi.spyOn(cancellationModule, 'runClient').mockImplementation(
      async (_executable, argumentsList) => {
        if (argumentsList[1] === '100') {
          return 'fixture shell start';
        }

        throw new Error('Process inspection failed.');
      },
    );
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (absent) {
        throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
      }

      return true;
    });

    const status = await controller.launch(input);

    expect(status).toMatchObject({
      outcome: 'failure',
      state: 'cleanupUnconfirmed',
      capacityHeld: true,
    });
    expect(status.failure).toContain(
      absent ? 'exited before readiness' : 'Process inspection failed.',
    );
    expect(controller.children()).toEqual({
      active: 0,
      uncertain: [expect.stringContaining(status.directory)],
    });
    expect(readEvent(status.directory, status.taskId, 'cleanup')?.stopped).toBe(false);
    expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
    expect(calls.some((call) => ['send-keys', 'close'].includes(call[1] ?? ''))).toBe(false);
  },
);

it('detects an owned worker exiting before readiness without waiting for the task deadline', async ({
  onTestFinished,
}) => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
  });
  let inspections = 0;
  const { controller, input, calls } = setup(onTestFinished, -1, async (argumentsList) => {
    if (argumentsList[1] === 'process-info' && ++inspections > 1) {
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: 'worker-1',
            shell_pid: 100,
            foreground_process_group_id: 100,
            foreground_processes: [{ pid: 100, argv: ['sh'] }],
          },
        },
      });
    }

    return argumentsList[1] === 'close' ? '{}' : '';
  });
  const started = performance.now();
  const status = await controller.launch({ ...input, timeout: 60_000 });

  expect(performance.now() - started).toBeLessThan(1500);
  expect(status).toMatchObject({ outcome: 'failure', state: 'stopped' });
  expect(status.failure).toContain('exited before readiness');
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(calls.some((call) => call[1] === 'send-keys')).toBe(false);
});

it.each(['missing report', 'accepted report'])(
  'detects post-readiness exit with %s before the deadline',
  async (reportState) => {
    vi.useFakeTimers();
    let exited = false;
    const { controller, input, calls, notifications } = setup(
      afterTest,
      0,
      async (argumentsList) => {
        if (exited && argumentsList[1] === 'process-info') {
          return JSON.stringify({
            result: {
              process_info: {
                pane_id: 'worker-1',
                shell_pid: 100,
                foreground_process_group_id: 100,
              },
            },
          });
        }

        return argumentsList[1] === 'close' ? '{}' : '';
      },
    );
    const launched = await controller.launch({ ...input, timeout: 60_000 });
    recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
    const report = {
      taskId: launched.taskId,
      outcome: 'success',
      summary: 'Saved handover.',
      evidence: ['source.ts:1'],
    };

    if (reportState === 'accepted report') {
      acceptReport(launched.directory, launched.taskId, report);
    }

    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    });
    exited = true;

    await vi.advanceTimersByTimeAsync(250);

    expect(controller.status(launched.taskId, 'parent-id')).toMatchObject({
      outcome: reportState === 'accepted report' ? 'success' : 'incomplete',
      state: 'stopped',
      report: reportState === 'accepted report' ? report : undefined,
    });
    expect(notifications).toHaveLength(1);
    expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
    expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
    expect(calls.some((call) => call[1] === 'send-keys')).toBe(false);
  },
);

it('cleans up an owned live pane even when startup failure evidence is corrupt', async ({
  onTestFinished,
}) => {
  let recordDirectory = '';
  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    0,
    async (argumentsList) => {
      if (argumentsList[1] === 'start') {
        recordDirectory = dirname(argumentsList[argumentsList.indexOf('--session') + 1] ?? '');
        writeFileSync(join(recordDirectory, 'startupFailure.json'), '{');
      }

      return '';
    },
  );

  const launch = controller.launch(input);
  await expect(launch).rejects.toThrow(/records|evidence/i);
  const task = readTask(recordDirectory);
  await expect(launch).rejects.toThrow(task.nativeSessionFile);
  expect(JSON.stringify(notifications)).toContain(task.nativeSessionId);
  expect(JSON.stringify(notifications)).toContain(task.nativeSessionFile);
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(calls.some((call) => call[1] === 'close')).toBe(false);
  expect(readFileSync(join(recordDirectory, 'startupFailure.json'), 'utf8')).toBe('{');
  expect(JSON.stringify(notifications)).toContain('worker-1');
  expect(JSON.stringify(notifications)).toMatch(/records|evidence/i);
  const evidence = notifications.find((notice) => 'evidenceError' in notice.content);
  expect(evidence).toBeDefined();
  expect(Object.keys(evidence?.content ?? {}).toSorted()).toEqual(
    ['taskId', 'name', 'evidenceError', 'recovery'].toSorted(),
  );
  expect(evidence?.content).not.toHaveProperty('state');
  expect(evidence?.content).not.toHaveProperty('outcome');
});

it('reports both startup and receipt failures after attempting owned pane cleanup', async ({
  onTestFinished,
}) => {
  let inspections = 0;
  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    -1,
    async (argumentsList) => {
      if (argumentsList[1] === 'process-info' && ++inspections === 2) {
        throw new Error('Injected worker identity probe failure');
      }

      return '';
    },
  );
  const original = records.recordEvent;
  vi.spyOn(records, 'recordEvent').mockImplementation((...argumentsList) => {
    if (argumentsList[2] === 'startupFailure') {
      throw new Error('Injected startup receipt write failure');
    }

    original(...argumentsList);
  });
  const launch = controller.launch(input);

  await expect(launch).rejects.toThrow('Injected startup receipt write failure');
  await expect(launch).rejects.toThrow('Injected worker identity probe failure');
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(JSON.stringify(notifications)).toContain('Injected startup receipt write failure');
  expect(JSON.stringify(notifications)).toContain('Injected worker identity probe failure');
  expect(JSON.stringify(notifications)).toContain('worker-1');
});

it.each(['cancelled', 'timeout'] as const)(
  'stops an owned live pane before reporting a failed %s receipt write',
  async (reason) => {
    vi.useFakeTimers();
    const { controller, input, calls, notifications } = setup(afterTest);
    const launched = await controller.launch(input);
    writeFileSync(join(launched.directory, 'report.json'), '{');
    const original = records.recordEvent;
    vi.spyOn(records, 'recordEvent').mockImplementation((...argumentsList) => {
      if (argumentsList[2] === reason) {
        throw new Error('Injected receipt write failure');
      }

      original(...argumentsList);
    });

    if (reason === 'timeout') {
      await vi.advanceTimersByTimeAsync(7600);
    }

    await expect(controller.cancel(launched.taskId, 'parent-id')).rejects.toThrow(
      /records|evidence/i,
    );
    expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
    expect(calls.some((call) => call[1] === 'close')).toBe(false);
    expect(JSON.stringify(notifications)).toContain('Injected receipt write failure');
    expect(JSON.stringify(notifications)).toContain('worker-1');
    expect(readFileSync(join(launched.directory, 'report.json'), 'utf8')).toBe('{');
  },
);

it('uses in-memory ownership to cancel even when the saved task is corrupt', async ({
  onTestFinished,
}) => {
  const { controller, input, calls, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  writeFileSync(join(launched.directory, 'task.json'), '{');

  const cancelled = controller.cancel(launched.taskId, 'parent-id');
  await expect(cancelled).rejects.toThrow(/evidence/);
  await expect(cancelled).rejects.toThrow(launched.nativeSessionFile);
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(JSON.stringify(notifications)).toContain('worker-1');
  expect(readFileSync(join(launched.directory, 'task.json'), 'utf8')).toBe('{');
});

it('distinguishes missing readiness timeout from startup failure inside the original deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const monitoring = Promise.withResolvers<undefined>();
  const budgets: number[] = [];
  let inspections = 0;
  const { controller, input, calls } = setup(
    onTestFinished,
    -1,
    async (argumentsList, budget, signal) => {
      budgets.push(budget);

      if (argumentsList[1] === 'process-info' && ++inspections === 2) {
        monitoring.resolve(undefined);

        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('Client aborted'));
            },
            { once: true },
          );
        });
      }

      return '';
    },
  );
  const launch = controller.launch(input);
  await monitoring.promise;
  await vi.advanceTimersByTimeAsync(7600);
  const status = await launch;

  expect(budgets.length).toBeGreaterThan(0);

  for (const budget of budgets) {
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(7500);
  }

  expect(status).toMatchObject({
    outcome: 'timeout',
    state: 'cleanupUnconfirmed',
    failure: undefined,
  });
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(readdirSync(status.directory)).not.toContain('dispatch.json');
});

it('polls slow worker readiness at 250 ms intervals', async ({ onTestFinished }) => {
  vi.spyOn(cancellationModule, 'runClient').mockResolvedValue('fixture start');
  const polled = Promise.withResolvers<undefined>();
  const inspections: number[] = [];
  const { controller, input } = setup(onTestFinished, -1, async (argumentsList) => {
    if (argumentsList[1] === 'process-info') {
      inspections.push(performance.now());

      if (inspections.length === 3) {
        polled.resolve(undefined);
      }
    }

    return '';
  });
  const launch = controller.launch(input);
  await polled.promise;
  controller.close();
  await launch;

  expect(inspections).toHaveLength(3);
  expect(inspections[2]! - inspections[1]!).toBeGreaterThanOrEqual(200);
  expect(inspections[2]! - inspections[1]!).toBeLessThan(1500);
});

it('reports recovered corrupt task evidence without its directory or native identity', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const launched = await controller.launch(input);
  controller.close();
  writeFileSync(join(launched.directory, 'task.json'), '{');
  const recovered = new WorkerController(directory);
  onTestFinished(() => {
    recovered.close();
  });

  expect(() => recovered.status(launched.taskId, 'parent-id')).toThrow(
    'saved evidence is unavailable',
  );
  expect(() => recovered.status(launched.taskId, 'parent-id')).toThrow('manually');
  let evidenceError = '';

  try {
    recovered.status(launched.taskId, 'parent-id');
  } catch (error) {
    evidenceError = String(error);
  }

  expect(evidenceError).not.toContain(launched.directory);
  expect(evidenceError).not.toContain('Native session unavailable');
});

it('carries saved recovery when a handle-free status finds corrupt report evidence', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  controller.close();
  writeFileSync(join(launched.directory, 'report.json'), '{');
  const recovered = new WorkerController(directory);
  onTestFinished(() => {
    recovered.close();
  });

  let evidenceFailure: unknown;

  try {
    recovered.status(launched.taskId, 'parent-id');
  } catch (error) {
    evidenceFailure = error;
  }

  expect(evidenceFailure).toBeInstanceOf(EvidenceUnavailableError);
  expect((evidenceFailure as EvidenceUnavailableError).recovery).toEqual({
    directory: launched.directory,
    nativeSessionFile: task.nativeSessionFile,
  });
  expect((evidenceFailure as Error).message).not.toContain(launched.directory);
  expect((evidenceFailure as Error).message).not.toContain(task.nativeSessionFile);
});

it('waits for worker readiness after herdr readiness without a new startup budget', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const started = Promise.withResolvers<undefined>();
  const { controller, input, calls } = setup(onTestFinished, 100, async (argumentsList) => {
    if (argumentsList[1] === 'start') {
      started.resolve(undefined);
    }

    return '';
  });
  const launch = controller.launch(input);
  await started.promise;
  await vi.advanceTimersByTimeAsync(150);
  const status = await launch;

  expect(status.failure).toBeUndefined();
  expect(status.state).toBe('starting');
  expect(status).not.toHaveProperty('outcome');
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
});

it('reports unreadable descendant evidence instead of breaking status', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished, 0);
  const status = await controller.launch(input);
  const reservations = status.reservationDirectory;

  if (!reservations) {
    throw new Error('Missing reservation directory.');
  }

  writeFileSync(join(reservations, 'broken.json'), '{');

  const degraded = taskStatus(status.directory);

  expect(degraded.unconfirmedChildren).toEqual([]);
  expect(degraded.descendantEvidence).toContain('capacity may still be held');
});

it('keeps a confirmed stop when the shell changes before the pane closes', async ({
  onTestFinished,
}) => {
  let checks = 0;
  let exited = false;
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (!exited || argumentsList[1] !== 'process-info') {
      return '';
    }

    checks += 1;

    return JSON.stringify({
      result: {
        process_info: {
          pane_id: 'worker-1',
          shell_pid: checks === 1 ? 100 : 200,
          foreground_process_group_id: checks === 1 ? 100 : 200,
        },
      },
    });
  });
  const launched = await controller.launch(input);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
  });
  exited = true;

  const status = await controller.cancel(launched.taskId, 'parent-id');

  expect(status.state).toBe('stopped');
  expect(status.cleanup).not.toContain('Cleanup unconfirmed');
  expect(status.cleanup).toContain('pane closure refused');
  expect(calls.some((call) => call[1] === 'close')).toBe(false);
});
