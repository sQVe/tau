import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import {
  fakeStartProcessId,
  takeStartTicket,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { contextOf, holdAskLock, recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { readAskRecord, readAskRecords, writeAskRecord } from '../record.js';
import type { HiddenAskRecord } from '../record.js';
import { createStartTicket } from '../startTicket/startTicket.js';
import { createArchitectTool } from '../tool.js';
import {
  askArchitect,
  askKeptClaimMessage,
  askLaunchFailureDetail,
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

const endedWithRecord = (
  hc: HcFake,
  root: string,
  settle: (record: HiddenAskRecord) => HiddenAskRecord,
) => {
  let askId: string | undefined;

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      const result = await hc.exec(command, commandArguments, options);
      const { records } = await readAskRecords(root);

      askId = records[0]?.askId;

      return result;
    }

    if (command === 'hc' && commandArguments[0] === 'wait' && askId !== undefined) {
      const record = await readAskRecord(root, askId);

      if (record?.route === 'hidden') {
        await writeAskRecord(root, settle(record));
      }
    }

    return hc.exec(command, commandArguments, options);
  };

  return exec;
};

it('returns the deadline outcome and writes nothing after a child timeout ends the wait', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', true));

  const exec = endedWithRecord(hc, root, (record) => ({
    ...record,
    status: 'timeout',
    detail: 'The child wrote the deadline first.',
  }));

  const result = await ask({ ...hc, exec }, root);

  const { records } = await readAskRecords(root);
  const askId = records[0]?.askId;

  expect(result).toMatchObject({
    details: {
      status: 'needsOpen',
      reason: 'The ask reached its deadline. Call architect open to talk to the architect.',
    },
  });

  if (askId === undefined) {
    throw new Error('The ask record was not written.');
  }

  expect(await readAskRecord(root, askId)).toMatchObject({
    status: 'timeout',
    detail: 'The child wrote the deadline first.',
  });
});

it('returns the answer after a sent record ends the wait', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', true));

  const exec = endedWithRecord(hc, root, (record) => ({
    ...record,
    status: 'sent',
    answer: 'Use --quick.',
  }));

  await expect(ask({ ...hc, exec }, root)).resolves.toMatchObject({
    details: { status: 'ended', answer: 'Use --quick.' },
  });
});

it('an abort before dispatch cancels its ticket and releases the claim', async ({
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
    beforeDispatch: () => {
      controller.abort(cancellation);

      return Promise.resolve();
    },
  }).catch((error: unknown) => error);

  expect(failure).toBe(cancellation);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
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

it.each([
  {
    name: 'timeout',
    settle: (record: Extract<Awaited<ReturnType<typeof readAskRecord>>, { route: 'hidden' }>) => ({
      ...record,
      status: 'timeout' as const,
      detail: 'The child wrote the deadline first.',
    }),
    expected: {
      status: 'needsOpen',
      reason: 'The ask reached its deadline. Call architect open to talk to the architect.',
    },
  },
  {
    name: 'sent',
    settle: (record: Extract<Awaited<ReturnType<typeof readAskRecord>>, { route: 'hidden' }>) => ({
      ...record,
      status: 'sent' as const,
      answer: 'Use --quick.',
    }),
    expected: { status: 'ended', answer: 'Use --quick.' },
  },
])(
  'keeps a $name record the child settled while the lead was stalled',
  async ({ settle, expected }) => {
    const { root } = await setup(onTestFinished);
    const hc = startFake();
    const launched = Promise.withResolvers<string>();
    const locked = Promise.withResolvers<Awaited<ReturnType<typeof holdAskLock>>>();
    let waits = 0;

    await recordSession(root);

    const exec: typeof hc.exec = async (command, commandArguments, options) => {
      if (command === 'hc' && commandArguments[0] === 'run') {
        const result = await hc.exec(command, commandArguments, options);
        const { records } = await readAskRecords(root);

        launched.resolve(records[0]?.askId ?? '');

        return result;
      }

      if (command === 'hc' && commandArguments[0] === 'wait') {
        waits += 1;

        if (waits === 1) {
          const askId = await launched.promise;

          locked.resolve(await holdAskLock(onTestFinished, root, askId));

          return succeededResult(endedWait('t-ask', false));
        }

        return succeededResult(endedWait('t-ask', true));
      }

      return hc.exec(command, commandArguments, options);
    };

    const asking = ask({ ...hc, exec }, root).catch((error: unknown) => error);
    const askId = await launched.promise;
    const held = await locked.promise;
    const record = await readAskRecord(root, askId);

    if (record?.route !== 'hidden') {
      throw new Error('The ask record is not hidden.');
    }

    await writeAskRecord(root, settle(record));
    held.release();

    const result = await asking;

    expect(result).toMatchObject({ details: expected });
    expect(await readAskRecord(root, askId)).toMatchObject(settle(record));
  },
);

it('keeps an answer saved between the repair scan and its get reply', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const hc = startFake();
  const getEntered = Promise.withResolvers<undefined>();
  const getRelease = Promise.withResolvers<undefined>();

  await recordSession(root);
  await writeAskRecord(root, runningAsk);
  hc.fail('run', 'hc run failed', 1);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'get') {
      getEntered.resolve(undefined);
      await getRelease.promise;
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
    hc: { ...hc, cwd: root, exec },
    liveAsk: () => Promise.reject(new Error('unexpected live ask')),
  };

  const asking = askArchitect(request).catch(() => undefined);

  await getEntered.promise;

  await writeAskRecord(root, {
    ...runningAsk,
    status: 'sent',
    answer: 'Use --quick.',
  });

  getRelease.resolve(undefined);
  await asking;

  expect(await readAskRecord(root, runningAsk.askId)).toMatchObject({
    status: 'sent',
    answer: 'Use --quick.',
  });
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

it('deletes an orphaned marker whose process is gone and starts', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const ticket = await createStartTicket(root, 'gone');
  const marker = `${ticket}.started.${fakeStartProcessId}`;

  useFakeStartProcess(cleanup, 'gone');
  hc.reply('wait', endedWait('t-ask', true));
  await writeFile(marker, '');
  await recordSession(root);

  const result = await ask(hc, root);

  expect(result).toMatchObject({ details: { status: 'needsOpen' } });
  expect(existsSync(marker)).toBe(false);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toHaveLength(1);
});

it('refuses an orphaned marker whose process runs and names the process id', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const ticket = await createStartTicket(root, 'gone');
  const marker = `${ticket}.started.${fakeStartProcessId}`;

  useFakeStartProcess(cleanup, 'running');
  await writeFile(marker, '');
  await recordSession(root);

  const result = await ask(hc, root);

  expect(result).toMatchObject({ details: { status: 'needsOpen' } });
  expect((result.details as { reason: string }).reason).toContain(String(fakeStartProcessId));
  expect(existsSync(marker)).toBe(true);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('refuses a malformed orphaned marker and names the path', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const ticket = await createStartTicket(root, 'gone');
  const marker = `${ticket}.started`;

  await writeFile(marker, '');
  await recordSession(root);

  const result = await ask(hc, root);

  expect(result).toMatchObject({ details: { status: 'needsOpen' } });
  expect((result.details as { reason: string }).reason).toContain(marker);
  expect(existsSync(marker)).toBe(true);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('bounds the hidden launch with the launch timeout', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  let timeout: number | undefined;

  hc.reply('wait', endedWait('t-ask', true));
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      timeout = options?.timeout;
    }

    return hc.exec(command, commandArguments, options);
  };

  await ask({ ...hc, exec }, root);

  expect(timeout).toBe(30_000);
});
