import { expect, it, vi } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { contextOf, recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { readAskRecord, readAskRecords, writeAskRecord } from '../record.js';
import { createArchitectTool } from '../tool.js';
import {
  askArchitect,
  askKeptClaimMessage,
  askUnconfirmedStopDetail,
  askWaitFailureDetail,
} from './ask.js';
import type { AskRequest } from './ask.js';

const ask = (hc: HcFake, root: string) =>
  createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

const statuses = async (root: string): Promise<string[]> => {
  const { records } = await readAskRecords(root);

  return records.map((record) => record.status);
};

const details = async (root: string): Promise<(string | null)[]> => {
  const { records } = await readAskRecords(root);

  return records.map((record) => record.detail);
};

const endedWait = (terminal: string, ended: boolean): string => {
  const reason = ended ? 'ended' : 'timeout';
  const exitCode = ended ? 0 : null;

  return JSON.stringify({ terminal, ended, reason, turn: 1, children: [], exit_code: exitCode });
};

const startFake = (): HcFake => {
  const hc = createHcFake();

  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));
  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'finished' }));

  return hc;
};

const failFirstWait = (hc: HcFake, error: Error): HcFake => {
  let waits = 0;

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      if (waits === 1) {
        throw error;
      }
    }

    return hc.exec(command, commandArguments, options);
  };

  return { ...hc, exec };
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

  expect(waits).toBe(2);
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

  expect(waits).toBe(2);
  expect(await statuses(root)).toEqual(['timeout']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('finds an aborted launch by its ask label and keeps the claim until the terminal ends', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const waitEntered = Promise.withResolvers<undefined>();
  const waitRelease = Promise.withResolvers<undefined>();
  let waits = 0;
  let runSignal: AbortSignal | undefined;
  let listArguments: string[] | undefined;

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      runSignal = options?.signal;

      return { code: 0, killed: true, truncated: false, stdout: '', stderr: '' };
    }

    if (command === 'hc' && commandArguments[0] === 'ls') {
      listArguments = [...commandArguments];

      return succeededResult(JSON.stringify({ terminals: [{ address: 't-ask', state: 'live' }] }));
    }

    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      if (waits === 1) {
        waitEntered.resolve(undefined);
        await waitRelease.promise;
      }

      return succeededResult(endedWait('t-ask', true));
    }

    return hc.exec(command, commandArguments, options);
  };

  const asking = ask({ ...hc, exec }, root);

  await waitEntered.promise;

  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();

  expect(runSignal).toBeUndefined();
  expect(listArguments).toContain('--label');
  expect(await statuses(root)).toEqual(['running']);

  waitRelease.resolve(undefined);

  await expect(asking).resolves.toMatchObject({ details: { status: 'needsOpen' } });
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('an abort before dispatch starts no launch and releases the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const hc = startFake();
  const controller = new AbortController();
  const cancellation = new Error('cancelled before dispatch');

  await recordSession(root);

  const request: AskRequest = {
    root,
    question: 'Which flag name?',
    leadTerminal: 't-lead',
    leadSessionId: 'session-lead',
    listenerPath: undefined,
    location: config.location,
    ui: { notify: vi.fn<() => void>() },
    hc: { ...hc, cwd: root, signal: controller.signal },
    liveAsk: () => Promise.reject(new Error('unexpected live ask')),
  };

  const failure = await askArchitect(request, {
    beforeLink: () => {
      controller.abort(cancellation);

      return Promise.resolve();
    },
  }).catch((error: unknown) => error);

  expect(failure).toBe(cancellation);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('keeps the record running with the unconfirmed-stop detail when the cleanup wait rejects', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  let waits = 0;

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

const runningAsk = {
  version: 2 as const,
  route: 'hidden' as const,
  askId: '0190c1d2-0000-7000-8000-000000000399',
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1900000000000,
  status: 'running' as const,
  detail: null,
  answer: null,
};

it('repairs a running ask whose terminal has ended', async ({ onTestFinished: cleanup }) => {
  const { root, config } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  await writeAskRecord(root, runningAsk);
  hc.replyGet('t-ask', JSON.stringify({ address: 't-ask', state: 'exited' }));
  hc.fail('run', 'hc run failed', 1);

  const request: AskRequest = {
    root,
    question: 'Which flag name?',
    leadTerminal: 't-lead',
    leadSessionId: 'session-lead',
    listenerPath: undefined,
    location: config.location,
    ui: { notify: vi.fn<() => void>() },
    hc: { ...hc, cwd: root },
    liveAsk: () => Promise.reject(new Error('unexpected live ask')),
  };

  await askArchitect(request).catch(() => undefined);

  expect(await readAskRecord(root, runningAsk.askId)).toMatchObject({ status: 'failed' });
});

it('leaves a running ask unchanged when its terminal lookup fails', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  await writeAskRecord(root, runningAsk);
  hc.failGet('t-ask', 'no such terminal');
  hc.fail('run', 'hc run failed', 1);

  const request: AskRequest = {
    root,
    question: 'Which flag name?',
    leadTerminal: 't-lead',
    leadSessionId: 'session-lead',
    listenerPath: undefined,
    location: config.location,
    ui: { notify: vi.fn<() => void>() },
    hc: { ...hc, cwd: root },
    liveAsk: () => Promise.reject(new Error('unexpected live ask')),
  };

  await askArchitect(request).catch(() => undefined);

  expect(await readAskRecord(root, runningAsk.askId)).toMatchObject({ status: 'running' });
});
