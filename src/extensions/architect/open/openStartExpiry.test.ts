import type { setTimeout as promiseDelay } from 'node:timers/promises';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { argumentAfter, failedResult } from '../../../../tests/execFake.js';
import { writeNextLockOwnerRecordSync } from '../../../../tests/lockOwnerRecord.js';
import {
  fakeStartProcessId,
  takeStartTicket,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import type { FakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import {
  adoptClaim,
  appCommands,
  open,
  openRequest,
  openTool,
  requestFor,
  startedTerminalResult,
} from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import {
  openArchitect,
  openKeptClaimMessage,
  startingError,
  takeoverAdoptedChildEndedError,
  takeoverChildGoneError,
  takeoverExpiryError,
  takeoverSeconds,
} from './open.js';

const poll = vi.hoisted(() => ({ started: Promise.withResolvers<undefined>() }));

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { globalTimerDelay } = await import('../../../../tests/timerFake.js');

  const delay = (<T>(milliseconds?: number, value?: T, options?: { signal?: AbortSignal }) => {
    poll.started.resolve(undefined);

    return globalTimerDelay(milliseconds, value, options);
  }) as typeof original.setTimeout;

  return { ...original, setTimeout: delay };
});

beforeEach(() => {
  poll.started = Promise.withResolvers<undefined>();
});

afterEach(() => {
  vi.useRealTimers();
});

const startFakeTimers = (): void => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
};

const takeoverMilliseconds = takeoverSeconds * 1_000;

// The stop probes the lock holder after the deadline. The child takes the claim on the second
// probe, so the first read sees no adoption and the stop must read the lock again before it
// signals the child.
const adoptOnSecondHolderProbeAfter = (
  cleanup: (callback: () => void) => void,
  root: string,
  deadline: number,
): void => {
  const previousKill = vi.mocked(process.kill).getMockImplementation();
  let probesAfterDeadline = 0;

  const spy = vi.spyOn(process, 'kill').mockImplementation((processId, signal) => {
    if (processId === process.pid && signal === 0 && Date.now() >= deadline) {
      probesAfterDeadline += 1;

      if (probesAfterDeadline === 2) {
        writeNextLockOwnerRecordSync(architectLockPath(root), {
          checkout: root,
          pid: fakeStartProcessId,
          token: 'adopted',
        });

        return true;
      }
    }

    return previousKill?.(processId, signal) ?? true;
  });

  cleanup(() => {
    spy.mockImplementation(previousKill ?? (() => true));
  });
};

// The stop checks its deadline after each adoption probe, so the fake clock must stand still while
// the real filesystem probe runs. Only a real delay lets that probe finish.
const waitForStopSignals = async (
  processControl: FakeStartProcess,
  count: number,
): Promise<void> => {
  const actual = await vi.importActual<{ setTimeout: typeof promiseDelay }>('node:timers/promises');

  for (let attempt = 0; attempt < 1_000 && processControl.signals.length < count; attempt += 1) {
    await actual.setTimeout(5);
  }
};

it('stops the pane child by process id at the deadline, releases after it is gone, and lets a retry start', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, hc, tool } = openTool(root, undefined, undefined, { takeover: false });
  const processControl = useFakeStartProcess(cleanup, 'running', true);

  await recordSession(root);
  startFakeTimers();

  const opening = open(tool, root, { request: openRequest }).catch((error: unknown) => error);

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(takeoverMilliseconds + 300);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(takeoverExpiryError().message);
  expect(processControl.signals).toEqual(['SIGTERM']);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(appCommands(app)).toContain('pane.split');

  vi.useRealTimers();

  const retry = openTool(root);
  const result = await open(retry.tool, root, { request: openRequest });

  expect(result.details).toMatchObject({ status: 'resumed' });
  expect(appCommands(retry.app)).toContain('pane.split');
});

it('keeps the claim when the child never goes away and finishes within one recovery window', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });
  const processControl = useFakeStartProcess(cleanup, 'running');

  await recordSession(root);
  startFakeTimers();

  const startedAt = Date.now();
  let finishedAt: number | undefined;

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv);

      return { code: 0, killed: true, truncated: false, stdout: '', stderr: '' };
    }

    return runtime.exec(command, commandArguments, options);
  };

  const request = requestFor(root, config.location, { ...runtime, exec });

  const opening = openArchitect(request)
    .catch((error: unknown) => error)
    .then((error: unknown) => {
      finishedAt = Date.now();

      return error;
    });

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  await waitForStopSignals(processControl, 2);
  await vi.advanceTimersByTimeAsync(5_000);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(openKeptClaimMessage(root));
  expect(processControl.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(finishedAt).toBeDefined();

  const stopStartedAt = processControl.signalTimes[0] ?? startedAt;

  expect((finishedAt as number) - stopStartedAt).toBeLessThanOrEqual(10_000);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('fails at once when the launched child dies before it takes the lock', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });

  useFakeStartProcess(cleanup, 'gone');
  await recordSession(root);
  startFakeTimers();

  const failure = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(takeoverChildGoneError().message);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('returns the takeover result when the child adopts after the wait expires', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });

  const processControl = useFakeStartProcess(cleanup, 'running');
  const sessionFile = await recordSession(root);

  startFakeTimers();

  const deadline = Date.now() + takeoverMilliseconds;

  adoptOnSecondHolderProbeAfter(cleanup, root, deadline);

  const opening = openArchitect(requestFor(root, config.location, runtime));

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(takeoverMilliseconds + 300);
  await processControl.nextSignal(1);
  await vi.advanceTimersByTimeAsync(5_000);

  const result = await opening;

  expect(result).toEqual({ status: 'resumed', sessionFile, model: 'a/architect' });

  expect(await readLiveLockHolder(architectLockPath(root))).toMatchObject({
    pid: fakeStartProcessId,
  });
});

it('throws when the child is gone after the wait saw its adoption', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime, terminals } = openTool(root, undefined, undefined, { takeover: false });
  const child = useFakeStartProcess(cleanup, 'running');

  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const holder = await readLiveLockHolder(architectLockPath(root));
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv);

      const release = await adoptClaim(root, holder?.token ?? '', 'adopted', fakeStartProcessId);

      if (release !== undefined) {
        cleanup(release);
      }

      child.state = 'gone';

      return startedTerminalResult(terminals, commandArguments);
    }

    return runtime.exec(command, commandArguments, options);
  };

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(takeoverAdoptedChildEndedError().message);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('keeps a paused child fence until its process is gone and then a retry starts one Pi', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });
  const processControl = useFakeStartProcess(cleanup, 'running');

  await recordSession(root);
  startFakeTimers();

  let splits = 0;

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      splits += 1;
      await takeStartTicket(argv);

      return { code: 0, killed: true, truncated: false, stdout: '', stderr: '' };
    }

    return runtime.exec(command, commandArguments, options);
  };

  const request = requestFor(root, config.location, { ...runtime, exec });
  const opening = openArchitect(request).catch((error: unknown) => error);

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  await waitForStopSignals(processControl, 2);

  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
  expect(splits).toBe(1);

  await expect(openArchitect(request)).rejects.toThrow(startingError(root).message);

  processControl.state = 'gone';

  await vi.advanceTimersByTimeAsync(5_000);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();

  vi.useRealTimers();

  const retry = openTool(root);
  const result = await open(retry.tool, root, { request: openRequest });

  expect(result.details).toMatchObject({ status: 'resumed' });
  const retrySplits = appCommands(retry.app).filter((name) => name === 'pane.split');

  expect(retrySplits).toHaveLength(1);
});

it('reports the kept claim when a lost launch leaves a child that never adopted', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });
  const child = useFakeStartProcess(cleanup, 'running');

  await recordSession(root);
  startFakeTimers();

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv);

      return failedResult('the launch reply failed');
    }

    return runtime.exec(command, commandArguments, options);
  };

  const opening = openArchitect(requestFor(root, config.location, { ...runtime, exec })).catch(
    (error: unknown) => error,
  );

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  await child.nextSignal(2);
  await vi.advanceTimersByTimeAsync(5_000);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(openKeptClaimMessage(root));
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('fails a space reply without a terminal and releases when the child is gone', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);

  const { app, hc, runtime } = openTool(root, { space: undefined }, undefined, {
    takeover: false,
  });

  useFakeStartProcess(cleanup, 'gone');
  app.overrideOutput('space.new', '{"ok":true}');
  await recordSession(root);

  const failure = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  const lookups = appCommands(app).filter((name) => name === 'ls');

  expect((failure as Error).message).toContain('herdr-app do');
  expect(lookups).toEqual([]);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('returns the normal result when a space reply has no terminal and the child adopted the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);

  const { app, hc, runtime } = openTool(root, { space: undefined }, undefined, {
    takeover: false,
  });

  useFakeStartProcess(cleanup, 'running');
  app.overrideOutput('space.new', '{"ok":true}');
  const sessionFile = await recordSession(root);

  const appExec: typeof app.exec = async (command, commandArguments, options) => {
    const result = await app.exec(command, commandArguments, options);

    if (commandArguments[1] === 'space.new') {
      const holder = await readLiveLockHolder(architectLockPath(root));

      if (holder !== undefined) {
        const release = await adoptClaim(root, holder.token, 'adopted', fakeStartProcessId);

        if (release !== undefined) {
          cleanup(release);
        }
      }
    }

    return result;
  };

  const routedExec: typeof runtime.exec = async (command, commandArguments, options) =>
    command === 'herdr-app'
      ? appExec(command, commandArguments, options)
      : runtime.exec(command, commandArguments, options);

  const result = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec: routedExec }),
  );

  expect(result).toEqual({ status: 'resumed', sessionFile, model: 'unknown' });
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);

  expect(await readLiveLockHolder(architectLockPath(root))).toMatchObject({ token: 'adopted' });
});

it('rejects a cancel when a space reply has no terminal and the child adopted the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);

  const { app, hc, runtime } = openTool(root, { space: undefined }, undefined, {
    takeover: false,
  });

  const controller = new AbortController();
  const cancellation = new Error('cancelled after the adoption');

  useFakeStartProcess(cleanup, 'running');
  app.overrideOutput('space.new', '{"ok":true}');
  await recordSession(root);

  const appExec: typeof app.exec = async (command, commandArguments, options) => {
    const result = await app.exec(command, commandArguments, options);

    if (commandArguments[1] === 'space.new') {
      const holder = await readLiveLockHolder(architectLockPath(root));

      if (holder !== undefined) {
        const release = await adoptClaim(root, holder.token, 'adopted', fakeStartProcessId);

        if (release !== undefined) {
          cleanup(release);
        }
      }

      controller.abort(cancellation);
    }

    return result;
  };

  const routedExec: typeof runtime.exec = async (command, commandArguments, options) =>
    command === 'herdr-app'
      ? appExec(command, commandArguments, options)
      : runtime.exec(command, commandArguments, options);

  const failure = await openArchitect(
    requestFor(root, config.location, {
      ...runtime,
      exec: routedExec,
      signal: controller.signal,
    }),
  ).catch((error: unknown) => error);

  expect(failure).toBe(cancellation);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toMatchObject({ token: 'adopted' });
});

it.each([
  { name: 'not JSON', reply: 'not json' },
  { name: 'JSON null', reply: 'null' },
  { name: 'a JSON array', reply: '[]' },
  { name: 'a non-string terminal', reply: '{"terminal":42}' },
  { name: 'a null terminal', reply: '{"terminal":null}' },
  { name: 'an empty terminal', reply: '{"terminal":""}' },
])('fails a space reply with $name and releases when the child is gone', async ({ reply }) => {
  const { root, config } = await setup(onTestFinished);

  const { app, hc, runtime } = openTool(root, { space: undefined }, undefined, {
    takeover: false,
  });

  useFakeStartProcess(onTestFinished, 'gone');
  app.overrideOutput('space.new', reply);
  await recordSession(root);

  const failure = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('herdr-app do');
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('reports a launch failure at once when the child never took the ticket', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, runtime } = openTool(root, undefined, undefined, { takeover: false });

  app.failCommand('pane.split', 'pane p-lead is gone');
  await recordSession(root);

  const failure = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('pane p-lead is gone');
  const lookups = appCommands(app).filter((name) => name === 'ls');

  expect((failure as Error).message).not.toBe(takeoverExpiryError().message);
  expect(lookups).toEqual(['ls']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('fails a split whose reply fails its schema without a lookup', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, runtime } = openTool(root, undefined, undefined, { takeover: false });

  useFakeStartProcess(cleanup, 'gone');
  app.overrideOutput('pane.split', '{"pane":"p-architect"}');
  await recordSession(root);

  const failure = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  const lookups = appCommands(app).filter((name) => name === 'ls');

  expect((failure as Error).message).toContain('herdr-app do pane.split');
  expect(lookups).toEqual(['ls']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('rejects a cancel in the recovered path after the child took over and does not kill it', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled after the child took over');
  const adopted = Promise.withResolvers<string>();

  useFakeStartProcess(cleanup, 'running');
  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const holder = await readLiveLockHolder(architectLockPath(root));
      const token = holder?.token ?? '';
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv);

      const adoptedToken = 'adopted';

      const release = await adoptClaim(root, token, adoptedToken, fakeStartProcessId);

      if (release !== undefined) {
        cleanup(release);
        adopted.resolve(adoptedToken);
      }

      controller.abort(cancellation);

      return { code: 0, killed: true, truncated: false, stdout: '', stderr: '' };
    }

    return runtime.exec(command, commandArguments, options);
  };

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec, signal: controller.signal }),
  ).catch((error: unknown) => error);

  expect(failure).toBe(cancellation);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);

  const holder = await readLiveLockHolder(architectLockPath(root));

  expect(holder?.token).toBe(await adopted.promise);
});

it('keeps a successful result when a split adopts the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { hc, runtime, terminals } = openTool(root, undefined, undefined, { takeover: false });
  const sessionFile = await recordSession(root);

  useFakeStartProcess(cleanup, 'running');

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const holder = await readLiveLockHolder(architectLockPath(root));
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv);

      const release = await adoptClaim(root, holder?.token ?? '', 'adopted', fakeStartProcessId);

      if (release !== undefined) {
        cleanup(release);
      }

      return startedTerminalResult(terminals, commandArguments);
    }

    return runtime.exec(command, commandArguments, options);
  };

  const result = await openArchitect(requestFor(root, config.location, { ...runtime, exec }));

  expect(result).toEqual({ status: 'resumed', sessionFile, model: 'a/architect' });
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
});
