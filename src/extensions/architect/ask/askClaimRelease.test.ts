import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import {
  fakeStartProcessId,
  takeStartTicket,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath, holdArchitectLock } from '../lock.js';
import { askArchitect } from './ask.js';
import type { AskRequest } from './ask.js';
import {
  askKeptClaimMessage,
  askLaunchFailureDetail,
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

const startDirectory = (root: string): string => join(root, '.tau', 'architect', 'start');

const childClaimToken = (commandArguments: readonly string[]): string | undefined =>
  commandArguments
    .find((argument) => argument.startsWith(claimArgument))
    ?.slice(claimArgument.length);

// The adopted lock belongs to the child process the marker names, not to this test process.
const renameLockHolder = async (root: string, processId: number): Promise<void> => {
  const directory = dirname(architectLockPath(root));

  const generations = (await readdir(directory))
    .map((name) => /^lock\.(\d+)$/u.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));

  const path = `${architectLockPath(root)}.${generations.toSorted((left, right) => left - right).at(-1)}`;
  const owner = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

  await writeFile(path, JSON.stringify({ ...owner, pid: processId }));
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

  await renameLockHolder(root, fakeStartProcessId);

  const started = `${claimToken}.started.${fakeStartProcessId}`;
  const adoptedMarker = `${claimToken}.adopted.${fakeStartProcessId}`;

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
  hc.reply('wait', endedWait('t-ask', true));

  const cancelled = failFirstWait(hc, new Error('The operation was cancelled.'));

  await expect(ask(cancelled, root)).rejects.toThrow(/cancelled/u);

  const kills = hc.calls
    .filter((call) => call.commandArguments[0] === 'kill')
    .map((call) => call.commandArguments);

  expect(kills).toEqual([['kill', '--json', '--', 't-ask']]);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toMatch(/cancel/u);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('a rejected wait stops the hidden terminal and fails its record before releasing', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', true));

  const rejected = failFirstWait(hc, new Error('The wait failed.'));
  const failure = await ask(rejected, root).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(false, failure));
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('keeps the record running and the claim live when a rejected wait terminal does not end', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'running');
  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', false));

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

      return succeededResult(endedWait('t-ask', waits > 1));
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

it('stops an adopted child that still runs when the terminal stop is not confirmed', async ({
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
  expect(child.signals).toEqual(['SIGTERM']);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toBe(askWaitFailureDetail(false, failure));
  expect((await details(root))[0]).not.toBe(askUnconfirmedStopDetail);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await readdir(startDirectory(root))).toEqual([]);
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
