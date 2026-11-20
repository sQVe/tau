import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { startLiveArchitect } from './fixtures/liveArchitect.js';
import { contextOf } from './fixtures/toolHarness.js';
import { blockFinalHandover, failOpenLiveAsks } from './open/openLiveAsks.js';
import { askRecordDirectory, askRecordPath, readAskRecord } from './record.js';

type LiveTool = Awaited<ReturnType<typeof startLiveArchitect>>['tool'];

interface RefusalState {
  root: string;
  askId: string;
  deliveries: number;
}

const faults = vi.hoisted(() => ({
  recordPath: '',
  recordAttempts: 0,
  recordWriteFailures: 0,
  lockReleaseFails: false,
  lockTruncateFails: false,
  lockReadFails: false,
  trapPoll: false,
  polls: 0,
}));

const resetFaults = (): void => {
  faults.recordPath = '';
  faults.recordAttempts = 0;
  faults.recordWriteFailures = 0;
  faults.lockReleaseFails = false;
  faults.lockTruncateFails = false;
  faults.lockReadFails = false;
  faults.trapPoll = false;
  faults.polls = 0;
};

afterEach(resetFaults);

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const targetsRecord = (path: string): boolean =>
    faults.recordPath !== '' && path === faults.recordPath;

  const targetsLock = (path: string): boolean =>
    faults.recordPath !== '' && path.startsWith(`${faults.recordPath}.lock.`);

  return {
    ...original,
    rename: async (...parameters: Parameters<typeof original.rename>) => {
      const destination = String(parameters[1]);

      if (targetsRecord(destination)) {
        faults.recordAttempts += 1;

        if (faults.recordWriteFailures > 0) {
          faults.recordWriteFailures -= 1;
          throw new Error('record rename failed');
        }
      }

      if (targetsLock(destination) && faults.lockReleaseFails) {
        throw new Error('lock release rename failed');
      }

      return original.rename(...parameters);
    },
    truncate: async (...parameters: Parameters<typeof original.truncate>) => {
      const path = parameters[0];

      if (typeof path === 'string' && targetsLock(path) && faults.lockTruncateFails) {
        faults.trapPoll = true;
        throw new Error('lock release truncate failed');
      }

      return original.truncate(...parameters);
    },
    readFile: (async (...parameters: Parameters<typeof original.readFile>) => {
      const path = parameters[0];

      if (typeof path === 'string' && targetsLock(path) && faults.lockReadFails) {
        throw new Error('lock acquisition read failed');
      }

      return original.readFile(...parameters);
    }) as typeof original.readFile,
  };
});

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    setTimeout: (async (...parameters: Parameters<typeof original.setTimeout>) => {
      if (faults.trapPoll) {
        faults.polls += 1;
        throw new Error('ask lock polled');
      }

      return original.setTimeout(...parameters);
    }) as typeof original.setTimeout,
  };
});

const finalHandover = { toolName: 'handover', input: { action: 'send', final: true } } as never;

const setupRefusingArchitect = async (
  cleanup: typeof onTestFinished,
  arm: (state: typeof faults) => void,
) => {
  const state: RefusalState = { root: '', askId: '', deliveries: 0 };

  const live = await startLiveArchitect(cleanup, {
    acceptArchitectAsk: async (request) => {
      state.askId = request.messageId;
      state.deliveries += 1;
      faults.recordPath = askRecordPath(state.root, request.messageId);
      arm(faults);

      return 'The architect refused this question.';
    },
  });

  state.root = live.root;

  return { ...live, state };
};

const askQuestion = (tool: LiveTool, root: string) =>
  tool
    .execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );

const repairAsk = (tool: LiveTool, root: string, askId: string, sessionId = 'session-lead') =>
  tool
    .execute('call', { action: 'ask', askId }, undefined, undefined, contextOf(root, {}, sessionId))
    .then(
      () => undefined,
      (error: unknown) => error,
    );

const newestLockPath = async (root: string, askId: string): Promise<string> => {
  const directory = askRecordDirectory(root);
  const names = await readdir(directory);
  const prefix = `${askId}.json.lock.`;

  const generations = names
    .filter((name) => name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length)))
    .toSorted(
      (left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)),
    );

  const newest = generations.at(-1);

  if (newest === undefined) {
    throw new Error(`No ask lock generation exists for ${askId}.`);
  }

  return join(directory, newest);
};

const releaseHeldLock = async (path: string): Promise<void> => {
  const owner = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

  await writeFile(path, JSON.stringify({ ...owner, released: true }));
};

it('a refused live ask recovers after its first record update fails', async ({
  onTestFinished: cleanup,
}) => {
  const { root, receiver, state, tool } = await setupRefusingArchitect(cleanup, (armed) => {
    armed.recordWriteFailures = 1;
  });

  const failure = await askQuestion(tool, root);
  const message = (failure as Error).message;

  expect(failure).toBeInstanceOf(Error);
  expect(message).toContain('The architect refused this question. Nothing was queued.');
  expect(message).toContain(`Ask ${state.askId} is failed.`);
  expect(message).toContain('Call architect ask again with the question.');
  expect(faults.recordAttempts).toBe(2);

  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'failed' });

  const sameId = await repairAsk(tool, root, state.askId);

  expect(sameId).toBeInstanceOf(Error);
  expect((sameId as Error).message).toMatch(/is failed\. Only an unknown ask can retry/);
  expect(state.deliveries).toBe(1);
  expect(receiver.savedRecords()).toEqual([]);

  const blocked = await blockFinalHandover(finalHandover, {
    root,
    sessionId: 'session-architect',
  });

  expect(blocked).toBeUndefined();
});

it('a refused live ask can finish record repair by ID without resending', async ({
  onTestFinished: cleanup,
}) => {
  const { root, receiver, state, tool } = await setupRefusingArchitect(cleanup, (armed) => {
    armed.recordWriteFailures = Number.POSITIVE_INFINITY;
  });

  const failure = await askQuestion(tool, root);
  const message = (failure as Error).message;

  expect(failure).toBeInstanceOf(Error);
  expect(message).toContain('The architect refused this question. Nothing was queued.');
  expect(message).toContain(`askId ${state.askId}`);
  expect(message).toContain('record rename failed');
  expect(message).toContain('Restore record access');
  expect(message).toContain('Do not reload Pi');
  expect(message).not.toContain('still sending');
  expect(faults.recordAttempts).toBe(2);

  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'sending' });

  const otherSession = await repairAsk(tool, root, state.askId, 'session-other');

  expect(otherSession).toBeInstanceOf(Error);
  expect((otherSession as Error).message).toMatch(/belongs to lead session session-lead/);
  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'sending' });
  expect(faults.recordAttempts).toBe(2);

  const stillFailing = await repairAsk(tool, root, state.askId);

  expect(stillFailing).toBeInstanceOf(Error);
  expect((stillFailing as Error).message).toContain('record rename failed');
  expect((stillFailing as Error).message).toContain(`askId ${state.askId}`);
  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'sending' });
  expect(faults.recordAttempts).toBe(3);
  expect(state.deliveries).toBe(1);

  faults.recordWriteFailures = 0;

  const repaired = await repairAsk(tool, root, state.askId);

  expect(repaired).toBeInstanceOf(Error);

  expect((repaired as Error).message).toContain(
    'The architect refused this question. Nothing was queued.',
  );

  expect((repaired as Error).message).toContain(`Ask ${state.askId} is failed.`);
  expect((repaired as Error).message).toContain('Call architect ask again with the question.');
  expect(faults.recordAttempts).toBe(4);

  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'failed' });
  expect(state.deliveries).toBe(1);
  expect(receiver.savedRecords()).toEqual([]);

  const repeated = await repairAsk(tool, root, state.askId);

  expect(repeated).toBeInstanceOf(Error);
  expect((repeated as Error).message).toMatch(/is failed\. Only an unknown ask can retry/);
  expect((repeated as Error).message).not.toContain('Call architect ask again');
  expect((repeated as Error).message).not.toContain('The architect refused this question');
  expect(faults.recordAttempts).toBe(4);
  expect(state.deliveries).toBe(1);

  const blocked = await blockFinalHandover(finalHandover, {
    root,
    sessionId: 'session-architect',
  });

  expect(blocked).toBeUndefined();
});

it('a refused live ask reports a held lock without polling during repair', async ({
  onTestFinished: cleanup,
}) => {
  const { root, receiver, state, tool } = await setupRefusingArchitect(cleanup, (armed) => {
    armed.recordWriteFailures = 1;
    armed.lockReleaseFails = true;
    armed.lockTruncateFails = true;
  });

  const failure = await askQuestion(tool, root);
  const message = (failure as Error).message;

  expect(failure).toBeInstanceOf(Error);
  expect(message).toContain('The architect refused this question. Nothing was queued.');
  expect(message).toContain(`askId ${state.askId}`);
  expect(message).toMatch(/lock.*held/i);
  expect(message).not.toContain('another live session');
  expect(message).toContain('after the lock releases');
  expect(faults.polls).toBe(0);
  expect(faults.recordAttempts).toBe(1);

  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'sending' });

  const lockPath = await newestLockPath(root, state.askId);
  const lockBytes = await readFile(lockPath, 'utf8');
  const owner = JSON.parse(lockBytes) as Record<string, unknown>;

  expect(owner['released']).toBeUndefined();
  expect(typeof owner['pid']).toBe('number');
  expect(typeof owner['token']).toBe('string');

  const sameId = await repairAsk(tool, root, state.askId);

  expect(sameId).toBeInstanceOf(Error);

  expect((sameId as Error).message).toContain(
    'The architect refused this question. Nothing was queued.',
  );

  expect((sameId as Error).message).toContain(`askId ${state.askId}`);
  expect((sameId as Error).message).toMatch(/lock.*held/i);
  expect((sameId as Error).message).not.toContain('another live session');
  expect((sameId as Error).message).toContain('after the lock releases');
  expect(faults.polls).toBe(0);
  expect(faults.recordAttempts).toBe(1);
  expect(await readFile(lockPath, 'utf8')).toBe(lockBytes);
  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'sending' });
  expect(state.deliveries).toBe(1);

  faults.lockReleaseFails = false;
  faults.lockTruncateFails = false;
  faults.trapPoll = false;
  await releaseHeldLock(lockPath);

  const repaired = await repairAsk(tool, root, state.askId);

  expect(repaired).toBeInstanceOf(Error);
  expect((repaired as Error).message).toContain(`Ask ${state.askId} is failed.`);
  expect((repaired as Error).message).toContain('Call architect ask again with the question.');
  expect(faults.polls).toBe(0);
  expect(faults.recordAttempts).toBe(2);
  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'failed' });
  expect(state.deliveries).toBe(1);
  expect(receiver.savedRecords()).toEqual([]);

  const blocked = await blockFinalHandover(finalHandover, {
    root,
    sessionId: 'session-architect',
  });

  expect(blocked).toBeUndefined();
});

it('a failed live ask repair does not claim the ask is still sending', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, receiver, state, tool } = await setupRefusingArchitect(cleanup, (armed) => {
    armed.recordWriteFailures = Number.POSITIVE_INFINITY;
  });

  const failure = await askQuestion(tool, root);

  expect(failure).toBeInstanceOf(Error);
  expect(faults.recordAttempts).toBe(2);
  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'sending' });

  faults.recordWriteFailures = 0;

  await failOpenLiveAsks(
    { root, sessionId: 'session-architect' },
    {
      hc: { ...hc, cwd: root },
      report: () => undefined,
      delivered: new Map(),
      uncertain: new Map(),
    },
  );

  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'failed' });

  const recordPath = askRecordPath(root, state.askId);
  const recordBytes = await readFile(recordPath, 'utf8');
  const attemptsBefore = faults.recordAttempts;

  faults.lockReadFails = true;

  const faulted = await repairAsk(tool, root, state.askId);

  expect(faulted).toBeInstanceOf(Error);

  expect((faulted as Error).message).toContain(
    'The architect refused this question. Nothing was queued.',
  );

  expect((faulted as Error).message).toContain(`askId ${state.askId}`);
  expect((faulted as Error).message).toContain('the record repair could not finish');
  expect((faulted as Error).message).not.toContain('still sending');
  expect((faulted as Error).message).not.toContain('Call architect ask again');
  expect(faults.recordAttempts).toBe(attemptsBefore);
  expect(await readFile(recordPath, 'utf8')).toBe(recordBytes);
  expect(state.deliveries).toBe(1);

  faults.lockReadFails = false;

  const repaired = await repairAsk(tool, root, state.askId);

  expect(repaired).toBeInstanceOf(Error);
  expect((repaired as Error).message).toContain(`Ask ${state.askId} is failed.`);
  expect((repaired as Error).message).toContain('Call architect ask again with the question.');
  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'failed' });

  const repeated = await repairAsk(tool, root, state.askId);

  expect(repeated).toBeInstanceOf(Error);
  expect((repeated as Error).message).toMatch(/is failed\. Only an unknown ask can retry/);
  expect((repeated as Error).message).not.toContain('Call architect ask again');
  expect(state.deliveries).toBe(1);
  expect(receiver.savedRecords()).toEqual([]);
});
