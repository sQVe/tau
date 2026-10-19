import { fsyncSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import * as cancellationModule from '../cancellation.js';
import * as loadoutModule from '../loadout.js';
import { acceptReport, readEvent, readTask, recordEvent } from '../records.js';
import * as records from '../records.js';
import { oldestReadableTaskVersion, taskVersion } from '../types.js';
import { WorkerController } from './controller.js';
import { completed, savedFiles, setup } from './fixtures/controllerFixture.js';
import { taskStatus } from './record.js';

vi.mock(import('node:fs'), { spy: true });

it('skips unpublished preparation debris while published attempts remain exclusive', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished, 0, undefined, undefined, 1);

  writeFileSync(
    fixture.input.parentSession,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: fixture.input.parentSessionId,
      cwd: fixture.directory,
    }) + '\n',
  );

  const originalPublish = records.publishRecord;

  const preparation = vi
    .spyOn(records, 'publishRecord')
    .mockImplementation((directory, name, value) => {
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw new Error('Initial task file sync failed.');
      });

      preparation.mockRestore();
      originalPublish(directory, name, value);
    });

  await expect(fixture.controller.launch(fixture.input)).rejects.toThrow('Task preparation');

  expect(fixture.calls.some((call) => ['start', 'apply', 'create'].includes(call[1] ?? ''))).toBe(
    false,
  );

  const abandoned = readdirSync(fixture.directory, { withFileTypes: true }).find((entry) =>
    entry.isDirectory(),
  );

  if (!abandoned) {
    throw new Error('Missing preparation evidence.');
  }

  const abandonedDirectory = join(fixture.directory, abandoned.name);
  const receiptFiles = readdirSync(abandonedDirectory);
  expect(receiptFiles).toHaveLength(1);
  expect(receiptFiles[0]).toMatch(/^\.receipt-/);
  const receipt = readFileSync(join(abandonedDirectory, receiptFiles[0] ?? ''));

  const launched = await fixture.controller.launch(fixture.input);
  expect(launched.state).toBe('starting');
  expect(launched).not.toHaveProperty('outcome');

  const current = {
    file: fixture.input.parentSession,
    id: fixture.input.parentSessionId,
  };

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

  const controller = new WorkerController(
    fixture.directory,
    fixture.client,
    undefined,
    undefined,
    1,
  );

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
    acceptance: ['Follow-up is done.'],
    timeout: 10000,
    parentSession: current.file,
    parentSessionId: current.id,
    parentPane: 'parent',
  };

  const context = { cwd: fixture.directory, isProjectTrusted: () => true } as Parameters<
    WorkerController['followUp']
  >[1];

  vi.spyOn(loadoutModule, 'validateSavedLoadout').mockImplementation(
    (value) => value as ReturnType<typeof readTask>['loadout'],
  );

  await expect(controller.followUp(input, context)).rejects.toThrow('published-attempt');
  expect(readdirSync(abandonedDirectory)).toEqual(receiptFiles);
});

it.each(['fork', 'unrelated'] as const)(
  'refuses follow-up from another parent session (%s) without changing records',
  async (relationship) => {
    const fixture = await completed();
    const parentSession = join(fixture.directory, 'other-parent.jsonl');

    writeFileSync(
      parentSession,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'other-parent',
        cwd: fixture.directory,
        ...(relationship === 'fork' ? { parentSession: fixture.input.parentSession } : {}),
      }) + '\n',
    );

    const saved = savedFiles(fixture.directory);
    fixture.calls.length = 0;

    await expect(
      fixture.controller.followUp(
        { ...fixture.input, parentSession, parentSessionId: 'other-parent' },
        fixture.context,
      ),
    ).rejects.toThrow('Task belongs to another parent session.');

    expect(savedFiles(fixture.directory)).toEqual(saved);
    expect(fixture.calls).toEqual([]);
  },
);

it.each(['pending', 'uncertain cleanup', 'dispatch', 'accepted', 'report'] as const)(
  'refuses follow-up without writes when a successor has %s evidence',
  async (evidence) => {
    const fixture = await completed();
    const directory = join(fixture.directory, 'successor');
    mkdirSync(directory);

    records.publish(directory, 'task.json', {
      ...fixture.source,
      taskId: 'successor',
      predecessorTaskId: fixture.source.taskId,
    });

    if (evidence !== 'pending') {
      recordEvent(directory, 'successor', 'cleanup', {
        detail: 'Cleanup result.',
        stopped: evidence !== 'uncertain cleanup',
      });
    }

    if (evidence === 'dispatch') {
      records.publish(directory, 'dispatch.json', { taskId: 'successor' });
    }

    if (evidence === 'accepted') {
      recordEvent(directory, 'successor', 'accepted', 'Accepted.');
    }

    if (evidence === 'report') {
      acceptReport(directory, 'successor', {
        taskId: 'successor',
        outcome: 'success',
        summary: 'Done.',
        evidence: [],
      });
    }

    const saved = savedFiles(fixture.directory);
    fixture.calls.length = 0;

    await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
      'successor',
    );

    expect(savedFiles(fixture.directory)).toEqual(saved);
    expect(fixture.calls).toEqual([['agent', 'list']]);
  },
);

it('admits follow-up with retired records and an unpublished directory', async () => {
  const fixture = await completed();

  const retiredRecords = [
    { ...fixture.source, version: 1, taskId: 'retired-first' },
    {
      ...fixture.source,
      version: oldestReadableTaskVersion - 1,
      taskId: 'retired-previous',
      predecessorTaskId: fixture.source.taskId,
    },
  ];

  for (const record of retiredRecords) {
    const directory = join(fixture.directory, record.taskId);
    mkdirSync(directory);
    records.publish(directory, 'task.json', record);
  }

  const unpublished = join(fixture.directory, 'unpublished');
  mkdirSync(unpublished);
  const saved = savedFiles(fixture.directory);
  const result = fixture.controller.followUp(fixture.input, fixture.context);

  await expect(result).resolves.toMatchObject({
    state: 'starting',
    predecessorTaskId: fixture.source.taskId,
  });

  expect(savedFiles(fixture.directory)).toEqual(expect.arrayContaining(saved));
  expect(readdirSync(unpublished)).toEqual([]);
});

it.for([
  ['no criteria', undefined],
  ['a blank item', ['Done.', ' ']],
] as const)(
  'refuses a follow-up of an editing worker with %s without writes',
  async ([, acceptance]) => {
    const fixture = await completed();
    const saved = savedFiles(fixture.directory);
    fixture.calls.length = 0;
    const { acceptance: _dropped, ...withoutCriteria } = fixture.input;

    const input =
      acceptance === undefined
        ? withoutCriteria
        : { ...withoutCriteria, acceptance: [...acceptance] };

    await expect(fixture.controller.followUp(input, fixture.context)).rejects.toThrow(
      /acceptance/i,
    );

    expect(fixture.calls).toEqual([]);
    expect(savedFiles(fixture.directory)).toEqual(saved);
  },
);

it('reports unreadable successor records and refuses follow-up without writes', async () => {
  const fixture = await completed();
  const directory = join(fixture.directory, 'unreadable');
  mkdirSync(directory);
  writeFileSync(join(directory, 'task.json'), '{');
  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'unreadable',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([['agent', 'list']]);
});

const newerTauRecord = (source: ReturnType<typeof readTask>, predecessorTaskId: string) => ({
  ...source,
  taskId: 'newer',
  name: 'critic-ab',
  predecessorTaskId,
  version: taskVersion + 1,
  loadout: { ...source.loadout, profile: 'critic' },
  futureField: 'written by a newer Tau',
});

it('follows up an unrelated task despite a newer Tau record', async () => {
  const fixture = await completed();
  const directory = join(fixture.directory, 'newer');
  mkdirSync(directory);
  records.publish(directory, 'task.json', newerTauRecord(fixture.source, 'unrelated'));

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).resolves.toMatchObject({
    state: 'starting',
    predecessorTaskId: fixture.source.taskId,
  });
});

it('refuses follow-up without writes when a newer Tau record names the same predecessor', async () => {
  const fixture = await completed();
  const directory = join(fixture.directory, 'newer');
  mkdirSync(directory);
  records.publish(directory, 'task.json', newerTauRecord(fixture.source, fixture.source.taskId));
  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'Cannot verify saved follow-up attempts',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([['agent', 'list']]);
});

it('refuses follow-up without writes when a current task that looks retired names the same predecessor', async () => {
  const fixture = await completed();
  const directory = join(fixture.directory, 'malformed');
  mkdirSync(directory);

  records.publish(directory, 'task.json', {
    ...fixture.source,
    taskId: 'malformed',
    predecessorTaskId: fixture.source.taskId,
    parentTaskId: 'ancestor',
  });

  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'Cannot verify saved follow-up attempts',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([['agent', 'list']]);
});

it.each([taskVersion])(
  'refuses follow-up without writes when a malformed version %i task names the same predecessor',
  async (version) => {
    const fixture = await completed();
    const directory = join(fixture.directory, 'malformed');
    mkdirSync(directory);
    const { monotonicDeadline: _monotonicDeadline, ...source } = fixture.source;

    writeFileSync(
      join(directory, 'task.json'),
      JSON.stringify({
        ...source,
        taskId: 'malformed',
        predecessorTaskId: fixture.source.taskId,
        version,
      }),
    );

    const saved = savedFiles(fixture.directory);
    fixture.calls.length = 0;

    await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
      'Cannot verify saved follow-up attempts',
    );

    expect(savedFiles(fixture.directory)).toEqual(saved);
    expect(fixture.calls).toEqual([['agent', 'list']]);
  },
);

it('refuses follow-up of a malformed source task ID without writes', async () => {
  const fixture = await completed();
  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(
    fixture.controller.followUp({ ...fixture.input, sourceTaskId: '../escape' }, fixture.context),
  ).rejects.toThrow('Invalid task identity.');

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([]);
});

it('refuses another follow-up when cleanup cannot verify the worker', async () => {
  let following = false;
  let absenceChecks = 0;

  const fixture = await completed(async (argumentsList) => {
    if (!following) {
      return '';
    }

    if (argumentsList[0] === 'agent' && argumentsList[1] === 'get') {
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

  const failed = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(failed.state).toBe('cleanupUnconfirmed');
  expect(readEvent(failed.directory, failed.taskId, 'cleanup')?.stopped).toBe(false);
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(failed.taskId);
  expect(fixture.calls.some((call) => call[1] === 'close')).toBe(false);
  const saved = savedFiles(fixture.directory);

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    failed.taskId,
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
});

it('allows follow-up retry after the worker exits before readiness', async () => {
  let exiting = false;

  const fixture = await completed(async (argumentsList) => {
    // The worker exits once herdr first sees it.
    if (exiting && argumentsList[0] === 'agent' && argumentsList[1] === 'get') {
      fixture.fake.state.stopped = true;
    }

    return '';
  });

  exiting = true;
  const failed = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(failed.state).toBe('stopped');
  expect(failed.failure).toContain('Worker exited before readiness');
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBeUndefined();
  expect(readdirSync(failed.directory)).not.toContain('dispatch.json');
  expect(readEvent(failed.directory, failed.taskId, 'accepted')).toBeUndefined();
  expect(records.readReport(failed.directory, failed.taskId)).toBeUndefined();
  expect(readEvent(failed.directory, failed.taskId, 'cleanup')?.stopped).toBe(true);
  exiting = false;
  fixture.fake.state.stopped = false;
  const retried = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(retried.state).toBe('starting');
  expect(retried.taskId).not.toBe(failed.taskId);
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(retried.taskId);
});

it('follows up a current-session task whose native header names another parent session', async () => {
  const fixture = await completed();
  const parentSession = join(fixture.directory, 'forked-parent.jsonl');
  const parentSessionId = 'forked-parent';

  writeFileSync(
    parentSession,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: parentSessionId,
      cwd: fixture.directory,
      parentSession: fixture.source.parentSession,
    }) + '\n',
  );

  const source = { ...fixture.source, parentSession, parentSessionId };
  const sourcePath = join(fixture.sourceDirectory, 'task.json');
  writeFileSync(sourcePath, JSON.stringify(source));
  const sourceBytes = readFileSync(sourcePath);
  const nativeBytes = readFileSync(source.nativeSessionFile);

  const next = await fixture.controller.followUp(
    { ...fixture.input, parentSession, parentSessionId },
    fixture.context,
  );

  expect(next).toMatchObject({ state: 'starting', predecessorTaskId: source.taskId });

  expect(readTask(next.directory)).toMatchObject({
    version: taskVersion,
    parentSession,
    parentSessionId,
    nativeSessionId: source.nativeSessionId,
    nativeSessionFile: source.nativeSessionFile,
  });

  expect(readFileSync(sourcePath)).toEqual(sourceBytes);
  expect(readFileSync(source.nativeSessionFile)).toEqual(nativeBytes);
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

  expect(
    fixture.controller.status(fixture.source.taskId, fixture.input.parentSessionId),
  ).toMatchObject({
    successorTaskId: next.taskId,
  });

  expect(readFileSync(join(fixture.sourceDirectory, 'task.json'))).toEqual(taskBytes);
  expect(readFileSync(join(fixture.sourceDirectory, 'report.json'))).toEqual(reportBytes);
  expect(readFileSync(fixture.source.nativeSessionFile)).toEqual(nativeBytes);
  const saved = savedFiles(fixture.directory);

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    task.taskId,
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
});

it.each(['cleanup', 'uncertain cleanup', 'handover', 'missing native', 'other parent'] as const)(
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

    const saved = savedFiles(fixture.directory);

    await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
      /cleanup|handover|native|another parent/i,
    );

    expect(savedFiles(fixture.directory)).toEqual(saved);
  },
);

it('classifies follow-up readiness deadline expiry as timeout rather than caller cancellation', async () => {
  let following = false;
  const started = Promise.withResolvers<undefined>();

  const fixture = await completed(async (argumentsList, budget, signal) => {
    if (following && argumentsList[0] === 'layout') {
      started.resolve(undefined);

      return fixture.fake.client(argumentsList, budget, signal);
    }

    return '';
  });

  following = true;
  const validationDeadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(validationDeadline.signal);
  // Leave slow runners room to reach start; an early rejection fails here instead of hanging.
  vi.spyOn(cancellationModule, 'runClient').mockResolvedValue('fixture shell start');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const pending = fixture.controller.followUp(
    { ...fixture.input, timeout: 10_000 },
    fixture.context,
  );

  await Promise.race([started.promise, pending]);
  validationDeadline.abort(new DOMException('Validation deadline expired.', 'TimeoutError'));
  await vi.advanceTimersByTimeAsync(10_000);
  const status = await pending;

  expect(status.outcome).toBe('timeout');
  expect(records.readEvent(status.directory, status.taskId, 'cancelled')).toBeUndefined();
  expect(records.readEvent(status.directory, status.taskId, 'timeout')).toBeDefined();
  const task = readTask(status.directory);
  expect(task.deadline - task.createdAt).toBe(10_000);
});

it('allows only one competing follow-up and preserves the native session across successive tasks', async () => {
  const fixture = await completed();
  fixture.calls.length = 0;
  const request = fixture.input;

  const attempts = await Promise.allSettled([
    fixture.controller.followUp(request, fixture.context),
    fixture.controller.followUp(request, fixture.context),
  ]);

  const successes = attempts.filter((entry) => entry.status === 'fulfilled');
  expect(successes).toHaveLength(1);
  const next = successes[0]?.value;

  if (!next) {
    throw new Error('Missing winner.');
  }

  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(next.taskId);

  await expect(
    fixture.controller.followUp({ ...request, sourceTaskId: next.taskId }, fixture.context),
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
  const latestController = new WorkerController(fixture.directory, fixture.client);

  afterTest(() => {
    latestController.close();
  });

  const latest = await latestController.followUp(
    { ...fixture.input, sourceTaskId: next.taskId },
    fixture.context,
  );

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

it.each(['cancelled', 'missing before launch'] as const)(
  'allows another follow-up after confirmed pre-start %s failure',
  async (failure) => {
    let following = false;
    const abort = new AbortController();
    let nativeFile = '';

    const fixture = await completed(async (argumentsList) => {
      if (following && argumentsList[1] === 'list' && failure === 'missing before launch') {
        rmSync(nativeFile);
      }

      if (following && argumentsList[1] === 'current' && failure === 'cancelled') {
        abort.abort(new Error('Caller cancelled.'));
      }

      return '';
    });

    nativeFile = fixture.source.nativeSessionFile;
    const nativeContents = readFileSync(nativeFile);
    following = true;

    const next = await fixture.controller.followUp(fixture.input, fixture.context, abort.signal);
    expect(next.outcome).toBe(failure === 'cancelled' ? 'cancelled' : 'failure');
    expect(next.state).toBe('stopped');
    expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBeUndefined();
    expect(records.readReport(next.directory, next.taskId)).toBeUndefined();
    following = false;

    const validationFailures: unknown[] = [];

    if (failure === 'missing before launch') {
      await fixture.controller.followUp(fixture.input, fixture.context).catch((error: unknown) => {
        validationFailures.push(error);
      });

      writeFileSync(nativeFile, nativeContents);
    }

    expect(validationFailures).toHaveLength(failure === 'missing before launch' ? 1 : 0);
    const retry = await fixture.controller.followUp(fixture.input, fixture.context);

    expect(retry.state).toBe('starting');
    expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(retry.taskId);
  },
);

it('refuses another follow-up when a lost launch response leaves an unconfirmed worker', async () => {
  let following = false;

  const fixture = await completed(async (argumentsList) => {
    if (following && argumentsList[0] === 'layout') {
      throw new Error('Response lost after launch');
    }

    return '';
  });

  following = true;

  const failed = await fixture.controller.followUp(fixture.input, fixture.context);
  const saved = savedFiles(fixture.directory);

  expect(failed.state).toBe('cleanupUnconfirmed');

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    failed.taskId,
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(failed.taskId);
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

  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'already live',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([['agent', 'list']]);
  live = [];
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);

  fixture.validation.mockImplementation((value) => {
    clock.mockReturnValue(20000);

    return value as ReturnType<typeof readTask>['loadout'];
  });

  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'budget expired',
  );

  expect(fixture.calls).toEqual([]);
  expect(savedFiles(fixture.directory)).toEqual(saved);
});

it('refuses full-cap native follow-up before publishing an attempt', async () => {
  const fixture = await completed();

  for (let index = 0; index < 12; index++) {
    await fixture.controller.launch({ ...fixture.input, loadout: fixture.source.loadout });
  }

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'capacity full',
  );

  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBeUndefined();

  expect(
    records
      .readTasks(fixture.directory)
      .some(({ task }) => task.predecessorTaskId === fixture.source.taskId),
  ).toBe(false);
});
