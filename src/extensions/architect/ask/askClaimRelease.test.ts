import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { setTimeout as promiseDelay } from 'node:timers/promises';

import { expect, it, vi, afterEach, beforeEach } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import { replaceCurrentLockOwnerPid } from '../../../../tests/lockOwnerRecord.js';
import {
  fakeStartProcessId,
  takeStartTicket,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath, holdArchitectLock } from '../lock.js';
import { acquireStartFence } from '../startFence/startFence.js';
import { askArchitect } from './ask.js';
import type { AskRequest } from './ask.js';
import {
  askAdoptedChildStoppedDetail,
  askFailedReason,
  askKeptClaimMessage,
  askLaunchFailureDetail,
  askTimeoutStopDetail,
  askTimeoutStopReason,
  askUnconfirmedStopDetail,
  askWaitFailureDetail,
} from './askHiddenRun.js';
import {
  ask,
  details,
  endedWait,
  failFirstWait,
  startFake,
  statuses,
} from './fixtures/askHarness.js';

const claimArgument = 'TAU_ARCHITECT_CLAIM=';

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

const startDirectory = (root: string): string => join(root, '.tau', 'architect', 'start');

const childClaimToken = (commandArguments: readonly string[]): string | undefined =>
  commandArguments
    .find((argument) => argument.startsWith(claimArgument))
    ?.slice(claimArgument.length);

// The child wins the claim without awaiting anything, so a probe can trigger the takeover.
const adoptLockSync = (root: string, token: string): void => {
  const lockPath = architectLockPath(root);
  const prefix = `${basename(lockPath)}.`;

  const generations = readdirSync(dirname(lockPath))
    .filter((name) => name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)));

  const next = Math.max(0, ...generations) + 1;

  writeFileSync(
    `${lockPath}.${next}`,
    JSON.stringify({
      pid: fakeStartProcessId,
      checkout: root,
      startedAt: new Date().toISOString(),
      token,
    }),
  );

  for (const generation of generations) {
    rmSync(`${lockPath}.${generation}`, { force: true });
  }
};

// The real child takes the ticket, adopts the claim, and renames its marker before it runs Pi. A
// reload or a shutdown can release the lock while Pi still runs.
const adoptAsChild = async (
  root: string,
  commandArguments: readonly string[],
): Promise<boolean> => {
  const claimToken = childClaimToken(commandArguments);

  if (claimToken === undefined) {
    throw new Error('The launch names no claim.');
  }

  const taken = await takeStartTicket(commandArguments);

  if (!taken) {
    return false;
  }

  const adopted = await holdArchitectLock(root, claimToken);

  // The adopted lock belongs to the child process the marker names, not to this test process.
  await replaceCurrentLockOwnerPid(architectLockPath(root), fakeStartProcessId);

  const ticket = commandArguments[commandArguments.indexOf('tau-architect-start') + 1];

  if (ticket === undefined) {
    throw new Error('The launch names no ticket.');
  }

  const ticketName = basename(ticket);
  const started = `${ticketName}.started.${fakeStartProcessId}`;
  const adoptedMarker = `${ticketName}.adopted.${fakeStartProcessId}`;

  await rename(join(startDirectory(root), started), join(startDirectory(root), adoptedMarker));
  await adopted.release();

  return true;
};

it('releases its claim when the ask launch never ran', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      throw new Error('spawn hc ENOENT');
    }

    return hc.exec(command, commandArguments, options);
  };

  await expect(ask({ ...hc, exec }, root)).rejects.toThrow(/spawn hc/u);

  expect(await statuses(root)).toEqual(['failed']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('a cancelled wait stops the hidden terminal and fails its record before releasing', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);

  const cancelled = failFirstWait(hc, new Error('The operation was cancelled.'));
  const failure = await ask(cancelled, root).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const kills = hc.calls
    .filter((call) => call.commandArguments[0] === 'kill')
    .map((call) => call.commandArguments);

  expect(kills).toEqual([['kill', '--json', '--', 't-ask']]);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(false, failure));
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('a rejected wait stops the hidden terminal and fails its record before releasing', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);

  const rejected = failFirstWait(hc, new Error('The wait failed.'));
  const failure = await ask(rejected, root).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(false, failure));
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('keeps the record running and the claim live when a rejected wait leaves a running child', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'running');
  await recordSession(root);

  const rejected = failFirstWait(hc, new Error('The wait failed.'));

  await expect(ask(rejected, root)).rejects.toThrow(askKeptClaimMessage(root));

  expect(await statuses(root)).toEqual(['running']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('a timeout whose terminal does not end returns the kept-claim message and keeps the record running', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  let waits = 0;

  useFakeStartProcess(cleanup, 'running');
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      return succeededResult(endedWait('t-ask', false));
    }

    return hc.exec(command, commandArguments, options);
  };

  await expect(ask({ ...hc, exec }, root)).resolves.toMatchObject({
    details: { status: 'needsOpen', reason: askKeptClaimMessage(root) },
  });

  expect(waits).toBe(1);
  expect(await statuses(root)).toEqual(['running']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('releases its claim when the architect ends before it takes the lock', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', true));

  await expect(ask(hc, root)).resolves.toMatchObject({ details: { status: 'needsOpen' } });

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('stops the hidden terminal at its deadline and releases after it ends', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  let waits = 0;

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      return succeededResult(endedWait('t-ask', false));
    }

    return hc.exec(command, commandArguments, options);
  };

  await expect(ask({ ...hc, exec }, root)).resolves.toMatchObject({
    details: { status: 'needsOpen' },
  });

  expect(waits).toBe(1);
  expect(await statuses(root)).toEqual(['timeout']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('stops the hidden ask by process id when the wait and the kill both fail', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const processControl = useFakeStartProcess(cleanup, 'running', true);

  await recordSession(root);
  hc.fail('kill', 'hc kill failed', 1);

  const rejected = failFirstWait(hc, new Error('The wait failed.'));
  const failure = await ask(rejected, root).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('The wait failed.');
  expect(processControl.signals).toEqual(['SIGTERM']);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(false, failure));
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('resolves an unused ticket when a valid reply arrives before the rename and a retry starts', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const replied = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const waitFailure = new Error('The wait failed.');

  useFakeStartProcess(cleanup, 'running');
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      replied.resolve(undefined);
      await release.promise;

      return succeededResult(JSON.stringify({ address: 't-ask', state: 'live' }));
    }

    if (command === 'hc' && commandArguments[0] === 'wait') {
      throw waitFailure;
    }

    return hc.exec(command, commandArguments, options);
  };

  const asking = ask({ ...hc, exec }, root).catch((error: unknown) => error);

  await replied.promise;

  const names = await readdir(join(root, '.tau', 'architect', 'start'));

  expect(names.some((name) => name.includes('.started.'))).toBe(false);

  release.resolve(undefined);

  const failure = await asking;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('The wait failed.');
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(false, failure));
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await readdir(join(root, '.tau', 'architect', 'start'))).toEqual([]);

  const retry = startFake();

  retry.reply('wait', endedWait('t-ask', true));

  await expect(ask(retry, root)).resolves.toMatchObject({ details: { status: 'needsOpen' } });
  expect(retry.calls.filter((call) => call.commandArguments[0] === 'run')).toHaveLength(1);
});

it('keeps the claim when an address-less launch child state is unknown', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'unknown');
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      await takeStartTicket(commandArguments);

      return { code: 0, killed: true, truncated: false, stdout: '', stderr: '' };
    }

    return hc.exec(command, commandArguments, options);
  };

  const failure = await ask({ ...hc, exec }, root).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askLaunchFailureDetail);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();

  const names = await readdir(join(root, '.tau', 'architect', 'start'));

  expect(names.some((name) => name.includes('.started.'))).toBe(true);
});

it('releases the claim and deletes the marker when an address-less launch child is gone', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'gone');
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      await takeStartTicket(commandArguments);

      return { code: 0, killed: true, truncated: false, stdout: '', stderr: '' };
    }

    return hc.exec(command, commandArguments, options);
  };

  await expect(ask({ ...hc, exec }, root)).rejects.toThrow(/hc run failed/u);

  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askLaunchFailureDetail);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await readdir(join(root, '.tau', 'architect', 'start'))).toEqual([]);
});

it('keeps the record running with the unconfirmed-stop detail when the cleanup wait rejects', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  let waits = 0;

  useFakeStartProcess(cleanup, 'running');
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      throw new Error(`The wait ${waits} failed.`);
    }

    return hc.exec(command, commandArguments, options);
  };

  await expect(ask({ ...hc, exec }, root)).rejects.toThrow(askKeptClaimMessage(root));

  expect(await statuses(root)).toEqual(['running']);
  expect(await details(root)).toEqual([askUnconfirmedStopDetail]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('records a real cancellation from the call signal as cancelled', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const hc = startFake();
  const controller = new AbortController();
  const cancellation = new Error('cancelled by the caller');
  let waits = 0;

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      if (waits === 1) {
        controller.abort(cancellation);

        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }

      return succeededResult(endedWait('t-ask', true));
    }

    return hc.exec(command, commandArguments, options);
  };

  const request: AskRequest = {
    root,
    question: 'Which flag name?',
    gateRecord: null,
    leadTerminal: 't-lead',
    leadSessionId: 'session-lead',
    listenerPath: undefined,
    location: config.location,
    ui: { notify: vi.fn<() => void>() },
    hc: { ...hc, cwd: root, exec, signal: controller.signal },
    liveAsk: () => Promise.reject(new Error('unexpected live ask')),
  };

  const failure = await askArchitect(request).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('aborted');
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(true, failure));
  expect((await details(root))[0]).not.toBe(askWaitFailureDetail(false, failure));
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('waits on a child that adopts during abandonment instead of failing the launch', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const signals: NodeJS.Signals[] = [];
  const realKill = process.kill.bind(process);
  let claimToken = '';
  let adoptOnProbe = false;
  let childState: 'running' | 'gone' = 'running';
  let taken = false;

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      taken = await takeStartTicket(commandArguments);
      claimToken = childClaimToken(commandArguments) ?? '';
      adoptOnProbe = true;

      return { code: 1, killed: false, truncated: false, stdout: '', stderr: 'launch failed' };
    }

    return hc.exec(command, commandArguments, options);
  };

  const spy = vi.spyOn(process, 'kill').mockImplementation((processId, signal) => {
    if (adoptOnProbe && processId === process.pid && signal === 0) {
      adoptOnProbe = false;
      adoptLockSync(root, claimToken);

      return true;
    }

    if (processId !== fakeStartProcessId) {
      return realKill(processId, signal);
    }

    if (signal === 0) {
      if (childState === 'gone') {
        throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      }

      return true;
    }

    signals.push(signal as NodeJS.Signals);

    return true;
  });

  cleanup(() => {
    spy.mockRestore();
  });

  const asking = ask({ ...hc, exec }, root).then(
    (value) => ({ kind: 'result' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );

  const first = await Promise.race([
    asking,
    poll.started.promise.then(() => ({ kind: 'waiting' as const })),
  ]);

  if (first.kind === 'waiting') {
    childState = 'gone';
  }

  const settled = first.kind === 'waiting' ? await asking : first;

  expect(settled.kind).toBe('result');

  if (settled.kind !== 'result') {
    throw new Error('The ask failed instead of waiting for the adopted child.');
  }

  expect(taken).toBe(true);
  expect(settled.value.details).toMatchObject({ status: 'failed', reason: askFailedReason });
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askAdoptedChildStoppedDetail);
  expect(signals).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await readdir(startDirectory(root))).toEqual([]);
});

it('releases its claim and fails the record when an adopted child stopped before the launch reply and a later caller swept', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const child = useFakeStartProcess(cleanup, 'gone');
  const waitFailure = new Error('The wait failed.');
  let markerSurvivedSweep = false;
  let taken = false;

  await recordSession(root);

  const rejected = failFirstWait(hc, waitFailure);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      taken = await adoptAsChild(root, commandArguments);

      const newer = await acquireStartFence(root);

      if (newer.kind !== 'acquired') {
        throw new Error('The later caller did not acquire the fence.');
      }

      const names = await readdir(startDirectory(root));

      markerSurvivedSweep = names.some((name) => name.includes('.adopted.'));

      await newer.fence.finish({ adopted: false, stopAttempted: false });

      return succeededResult(JSON.stringify({ address: 't-ask', state: 'live' }));
    }

    return rejected.exec(command, commandArguments, options);
  };

  const failure = await ask({ ...rejected, exec }, root).catch((error: unknown) => error);

  expect(taken).toBe(true);
  expect(markerSurvivedSweep).toBe(true);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('The wait failed.');
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(false, failure));
  expect((await details(root))[0]).not.toBe(askUnconfirmedStopDetail);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(child.signals).toEqual([]);
  expect(await readdir(startDirectory(root))).toEqual([]);
});

it('keeps the newer claim live when the cached adopted child is gone before the wait rejects', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const child = useFakeStartProcess(cleanup, 'running');
  const waitFailure = new Error('The wait failed.');
  let taken = false;
  let newerToken: string | undefined;

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      taken = await adoptAsChild(root, commandArguments);

      return succeededResult(JSON.stringify({ address: 't-ask', state: 'live' }));
    }

    if (command === 'hc' && commandArguments[0] === 'wait') {
      child.state = 'gone';

      const newer = await acquireStartFence(root);

      if (newer.kind !== 'acquired') {
        throw new Error('The newer caller did not acquire the fence.');
      }

      newerToken = (await readLiveLockHolder(architectLockPath(root)))?.token;

      throw waitFailure;
    }

    return hc.exec(command, commandArguments, options);
  };

  const failure = await ask({ ...hc, exec }, root).catch((error: unknown) => error);

  expect(taken).toBe(true);
  expect(failure).toBeInstanceOf(Error);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(false, failure));
  expect((await details(root))[0]).not.toBe(askUnconfirmedStopDetail);
  expect(child.signals).toEqual([]);

  expect(await readLiveLockHolder(architectLockPath(root))).toMatchObject({
    token: newerToken,
  });
});

it('releases its claim and fails the record when an adopted child stopped hard', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const child = useFakeStartProcess(cleanup, 'gone');
  let taken = false;

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      taken = await adoptAsChild(root, commandArguments);
    }

    return hc.exec(command, commandArguments, options);
  };

  const failure = await ask({ ...hc, exec }, root).catch((error: unknown) => error);

  expect(taken).toBe(true);
  expect(failure).toBeInstanceOf(Error);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(false, failure));
  expect((await details(root))[0]).not.toBe(askUnconfirmedStopDetail);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(child.signals).toEqual([]);
  expect(await readdir(startDirectory(root))).toEqual([]);
});

it('keeps a failed wait running and never signals an adopted child that still runs', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const child = useFakeStartProcess(cleanup, 'running', true);
  let taken = false;

  await recordSession(root);
  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'live' }));

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      taken = await adoptAsChild(root, commandArguments);
    }

    return hc.exec(command, commandArguments, options);
  };

  const failure = await ask({ ...hc, exec }, root).catch((error: unknown) => error);

  expect(taken).toBe(true);
  expect(failure).toBeInstanceOf(Error);
  expect(child.signals).toEqual([]);
  expect(await statuses(root)).toEqual(['running']);
  expect(await details(root)).toEqual([askUnconfirmedStopDetail]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();

  const names = await readdir(startDirectory(root));

  expect(names.some((name) => name.includes('.adopted.'))).toBe(true);
});

it('keeps a timeout running and never signals an adopted child that still runs', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const child = useFakeStartProcess(cleanup, 'running', true);
  let taken = false;

  await recordSession(root);
  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'live' }));
  hc.reply('wait', endedWait('t-ask', false));

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      taken = await adoptAsChild(root, commandArguments);
    }

    return hc.exec(command, commandArguments, options);
  };

  const result = await ask({ ...hc, exec }, root);

  expect(taken).toBe(true);

  expect(result.details).toMatchObject({
    status: 'needsOpen',
    reason: askTimeoutStopReason,
  });

  expect(child.signals).toEqual([]);
  expect(await statuses(root)).toEqual(['running']);
  expect(await details(root)).toEqual([askTimeoutStopDetail]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('fails its own record and releases the claim after a real-shaped nonzero launch exit', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.fail('run', 'hc run failed: the terminal command exited 1', 1);

  await expect(ask(hc, root)).rejects.toThrow(/hc run failed/u);

  expect(await statuses(root)).toEqual(['failed']);
  expect(await details(root)).toEqual([askLaunchFailureDetail]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('waits on an adopted child after an address-less launch and settles its running record', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const child = useFakeStartProcess(cleanup, 'running');
  let taken = false;

  await recordSession(root);
  startFakeTimers();

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      taken = await adoptAsChild(root, commandArguments);

      return { code: 1, killed: false, truncated: false, stdout: '', stderr: 'launch failed' };
    }

    return hc.exec(command, commandArguments, options);
  };

  const asking = ask({ ...hc, exec }, root);

  await poll.started.promise;

  child.state = 'gone';

  await vi.advanceTimersByTimeAsync(1_000);

  const result = await asking;

  expect(taken).toBe(true);
  expect(result.details).toMatchObject({ status: 'failed', reason: askFailedReason });
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askAdoptedChildStoppedDetail);
  expect(child.signals).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await readdir(startDirectory(root))).toEqual([]);
});

it('ends the adopted-child wait on abort without signalling the child', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const hc = startFake();
  const child = useFakeStartProcess(cleanup, 'running');
  const controller = new AbortController();
  const cancellation = new Error('cancelled while waiting for the adopted child');
  let taken = false;

  await recordSession(root);
  startFakeTimers();

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      taken = await adoptAsChild(root, commandArguments);

      return { code: 1, killed: false, truncated: false, stdout: '', stderr: 'launch failed' };
    }

    return hc.exec(command, commandArguments, options);
  };

  const request: AskRequest = {
    root,
    question: 'Which flag name?',
    gateRecord: null,
    leadTerminal: 't-lead',
    leadSessionId: 'session-lead',
    listenerPath: undefined,
    location: config.location,
    ui: { notify: vi.fn<() => void>() },
    hc: { ...hc, cwd: root, exec, signal: controller.signal },
    liveAsk: () => Promise.reject(new Error('unexpected live ask')),
  };

  const asking = askArchitect(request).catch((error: unknown) => error);

  await poll.started.promise;
  controller.abort(cancellation);

  const actual = await vi.importActual<{ setTimeout: typeof promiseDelay }>('node:timers/promises');

  const stillWaiting = actual.setTimeout(500).then(() => 'still-waiting' as const);
  const settled = await Promise.race([asking, stillWaiting]);

  expect(taken).toBe(true);
  expect(settled).toBe(cancellation);
  expect(child.signals).toEqual([]);
  expect(await statuses(root)).toEqual(['running']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
