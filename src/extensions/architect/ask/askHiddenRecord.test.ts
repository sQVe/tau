import { rm } from 'node:fs/promises';

import { expect, it, onTestFinished, vi } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { holdAskLock, recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { askRecordPath, readAskRecord, readAskRecords, writeAskRecord } from '../record.js';
import { acquireStartFence } from '../startFence/startFence.js';
import { askArchitect } from './ask.js';
import type { AskRequest } from './ask.js';
import {
  askEndedDetail,
  askEndedFailureDetail,
  askEndedReason,
  askFailedReason,
  askKeptClaimMessage,
  askMissingRecordReason,
  askUnreadableAnswerReason,
  startHiddenAskRun,
} from './askHiddenRun.js';
import { ask, endedWait, endedWithRecord, runningAsk, startFake } from './fixtures/askHarness.js';

it.each([
  { exitCode: 1, signal: null },
  { exitCode: null, signal: 9 },
])(
  'returns the failed result when the child ends with exit code $exitCode and signal $signal',
  async ({ exitCode, signal }) => {
    const { root } = await setup(onTestFinished);
    const hc = startFake();

    await recordSession(root);
    hc.reply('wait', endedWait('t-ask', true, exitCode, signal));

    const result = await ask(hc, root);

    expect(result).toMatchObject({ details: { status: 'failed', reason: askFailedReason } });

    const { records } = await readAskRecords(root);

    expect(records[0]).toMatchObject({ status: 'failed', detail: askEndedFailureDetail });
    expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  },
);

it.each([0, null])(
  'returns the clean-end outcome when the wait ends with exit code %s',
  async (exitCode) => {
    const { root } = await setup(onTestFinished);
    const hc = startFake();

    await recordSession(root);
    hc.reply('wait', endedWait('t-ask', true, exitCode));

    const result = await ask(hc, root);

    expect(result).toMatchObject({
      details: { status: 'needsOpen', reason: askEndedReason },
    });

    const { records } = await readAskRecords(root);

    expect(records[0]).toMatchObject({ status: 'failed', detail: askEndedDetail });
    expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  },
);

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

it('returns a distinct reason when the settled ask record is missing', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  let recordPath: string | undefined;

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', true));

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      const result = await hc.exec(command, commandArguments, options);
      const { records } = await readAskRecords(root);
      const askId = records[0]?.askId;

      recordPath = askId === undefined ? undefined : askRecordPath(root, askId);

      return result;
    }

    if (command === 'hc' && commandArguments[0] === 'wait' && recordPath !== undefined) {
      await rm(recordPath, { force: true });
    }

    return hc.exec(command, commandArguments, options);
  };

  const result = await ask({ ...hc, exec }, root);

  expect(result).toMatchObject({
    details: { status: 'needsOpen', reason: askMissingRecordReason },
  });

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(result).not.toMatchObject({ details: { reason: askKeptClaimMessage(root) } });
});

it('returns a distinct reason for a sent record without an answer', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', true));

  const exec = endedWithRecord(hc, root, (record) => ({
    ...record,
    status: 'sent',
    answer: null,
  }));

  const result = await ask({ ...hc, exec }, root);

  expect(result).toMatchObject({
    details: { status: 'needsOpen', reason: askUnreadableAnswerReason },
  });

  const { records } = await readAskRecords(root);

  expect(records[0]).toMatchObject({ status: 'sent', answer: null });
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(result).not.toMatchObject({ details: { reason: askKeptClaimMessage(root) } });
});

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
    gateRecord: null,
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
    gateRecord: null,
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
  {
    name: 'failed',
    settle: (record: Extract<Awaited<ReturnType<typeof readAskRecord>>, { route: 'hidden' }>) => ({
      ...record,
      status: 'failed' as const,
      detail: 'The child failed first.',
    }),
    expected: { status: 'failed' },
  },
])(
  'keeps a $name record the child settled while the lead was stalled',
  async ({ settle, expected }) => {
    const { root, config } = await setup(onTestFinished);
    const hc = startFake();
    const launched = Promise.withResolvers<string>();
    const locked = Promise.withResolvers<Awaited<ReturnType<typeof holdAskLock>>>();
    const waiting = Promise.withResolvers<undefined>();
    let waits = 0;

    const sessionFile = await recordSession(root);

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

    const request: AskRequest = {
      root,
      question: 'Which flag name?',
      gateRecord: null,
      leadTerminal: 't-lead',
      leadSessionId: 'session-lead',
      listenerPath: undefined,
      location: config.location,
      ui: { notify: vi.fn<() => void>() },
      hc: { ...hc, cwd: root, exec },
      liveAsk: () => Promise.reject(new Error('unexpected live ask')),
    };

    const acquisition = await acquireStartFence(root);

    if (acquisition.kind !== 'acquired') {
      throw new Error('The start fence was not acquired.');
    }

    const run = startHiddenAskRun(request, acquisition.fence, {
      onWaiting: () => {
        waiting.resolve(undefined);
      },
    });

    await acquisition.fence.createTicket();

    const asking = (async () => {
      try {
        return await run.start(sessionFile, 'a/architect');
      } finally {
        await run.settle();
      }
    })().catch((error: unknown) => error);

    const askId = await launched.promise;
    const held = await locked.promise;

    await waiting.promise;

    const record = await readAskRecord(root, askId);

    if (record?.route !== 'hidden') {
      throw new Error('The ask record is not hidden.');
    }

    await writeAskRecord(root, settle(record));
    held.release();

    const result = await asking;

    expect(result).toMatchObject(expected);
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
  hc.replyGet('t-ask', JSON.stringify({ address: 't-ask', state: 'exited' }));
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
    gateRecord: null,
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

it('keeps a running ask whose terminal changed between the repair scan and its lock', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const hc = startFake();
  const getEntered = Promise.withResolvers<undefined>();
  const getRelease = Promise.withResolvers<undefined>();

  await recordSession(root);
  await writeAskRecord(root, runningAsk);
  hc.replyGet('t-ask', JSON.stringify({ address: 't-ask', state: 'exited' }));
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
    gateRecord: null,
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

  await writeAskRecord(root, { ...runningAsk, terminal: 't-other' });

  getRelease.resolve(undefined);
  await asking;

  expect(await readAskRecord(root, runningAsk.askId)).toMatchObject({
    status: 'running',
    terminal: 't-other',
  });
});
