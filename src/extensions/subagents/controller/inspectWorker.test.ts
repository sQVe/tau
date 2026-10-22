import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { agentResponse, herdrFake } from '../../../../tests/herdrFake.js';
import * as cancellation from '../cancellation.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import { recordEvent } from '../records.js';
import type { Task } from '../types.js';
import { herdrReply } from './fixtures/herdrReply.js';
import { isHerdrError, waitForPiIdentity, waitForWorkerReadiness } from './inspect.js';
import { createHandle } from './task.js';

vi.mock(import('node:timers/promises'), async (importOriginal) => ({
  ...(await importOriginal()),
  setTimeout: (await import('./fixtures/globalTimerDelay.js')).globalTimerDelay,
}));

const token = '/tmp/worker-session.jsonl';
const processId = 4242;
const terminalId = 'pane-terminal';

// The test ends a loop that a mutant would turn into a busy loop.
const agentCallLimit = 30;

const herdrError = (code: string, wrapped = false) => {
  const failure = Object.assign(new Error('herdr failed'), {
    stderr: JSON.stringify({ error: { code } }),
  });

  return wrapped ? new Error('client failed', { cause: failure }) : failure;
};

beforeEach(() => {
  vi.spyOn(cancellation, 'runClient').mockResolvedValue('saved start');
  vi.spyOn(cancellation, 'processAbsent').mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const workerHandle = (directory = '/tmp/task', owned = false) => {
  const task = {
    taskId: 'task',
    cancellationBudget: 0,
    nativeSessionFile: token,
    loadout: fixtureLoadout('/tmp'),
  };

  const handle = createHandle(directory, task as Task, performance.now() + 60_000);

  handle.identity.terminalId = terminalId;
  handle.startup.neverStarted = false;

  if (owned) {
    handle.identity.owned = {
      version: 2,
      kind: 'pi',
      paneId: 'pane',
      terminalId,
      shellPid: processId,
      processId,
      token,
      startedAt: 'saved start',
    };
  }

  return handle;
};

const sessionAgent = (session: unknown): string =>
  agentResponse({ pane_id: 'pane', agent: 'pi', agent_session: session });

const herdr = (setup?: (fake: ReturnType<typeof herdrFake>) => void) => {
  const fake = herdrFake();
  let agentCalls = 0;

  fake.seedWorker({
    paneId: 'pane',
    terminalId,
    processId,
    session: token,
    argv: ['pi', token],
  });

  setup?.(fake);

  return async (argumentsList: string[]): Promise<string> => {
    if (argumentsList[0] === 'agent' && argumentsList[1] === 'get') {
      agentCalls += 1;

      if (agentCalls > agentCallLimit) {
        throw new Error('The test stopped polling.');
      }
    }

    return fake.client(argumentsList, 0);
  };
};

it('identifies a Pi worker whose pane, session, and process agree', async () => {
  const owned = await waitForPiIdentity(workerHandle(), herdr());

  expect(owned).toMatchObject({ paneId: 'pane', terminalId, shellPid: processId });
});

it.each([
  ['no session yet', undefined],
  ['a null session', null],
])('keeps polling while herdr reports %s', async (_name, session) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const identity = waitForPiIdentity(
    workerHandle(),
    herdr((fake) => {
      fake.queueAgentReplies(terminalId, [sessionAgent(session), sessionAgent(session)]);
    }),
  );

  await vi.advanceTimersByTimeAsync(600);

  expect(await identity).toMatchObject({ paneId: 'pane' });
});

it.each([
  ['an empty session value', 'emptySessionValue.json'],
  ['a session that is not an object', 'sessionNotObject.json'],
])('fails at once on %s', async (_name, reply) => {
  await expect(
    waitForPiIdentity(
      workerHandle(),
      herdr((fake) => {
        fake.malformedEvidence(terminalId, 'agent', herdrReply(reply));
      }),
    ),
  ).rejects.toThrow('integration');
});

it('keeps polling while herdr has not detected the agent of a new worker', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const identity = waitForPiIdentity(
    workerHandle(),
    herdr((fake) => {
      fake.queueAgentReplies(terminalId, [
        herdrError('agent_not_found'),
        herdrError('agent_not_found'),
      ]);
    }),
  );

  await vi.advanceTimersByTimeAsync(600);

  expect(await identity).toMatchObject({ paneId: 'pane' });
});

it('does not wait for the agent of a worker that Tau already identified', async () => {
  await expect(
    waitForPiIdentity(
      workerHandle('/tmp/task', true),
      herdr((fake) => {
        fake.holdReply(terminalId, 'agent', herdrError('agent_not_found'));
      }),
    ),
  ).rejects.toSatisfy((error) => isHerdrError(error, 'agent_not_found'));
});

it('fails at once on a herdr error other than a missing agent', async () => {
  await expect(
    waitForPiIdentity(
      workerHandle(),
      herdr((fake) => {
        fake.holdReply(terminalId, 'agent', herdrError('pane_not_found'));
      }),
    ),
  ).rejects.toSatisfy((error) => isHerdrError(error, 'pane_not_found'));
});

it('rejects a pane whose agent is not Pi', async () => {
  await expect(
    waitForPiIdentity(
      workerHandle(),
      herdr((fake) => {
        fake.holdReply(
          terminalId,
          'agent',
          agentResponse({ pane_id: 'pane', agent: 'claude', agent_session: { value: token } }),
        );
      }),
    ),
  ).rejects.toThrow('identity');
});

const pendingSession = (fake: ReturnType<typeof herdrFake>) => {
  fake.holdReply(terminalId, 'agent', sessionAgent(undefined));
};

const settled = (promise: Promise<unknown>) => {
  const state: { done: boolean; failure?: unknown } = { done: false };

  promise
    .then(
      () => undefined,
      (error: unknown) => {
        state.failure = error;
      },
    )
    .then(() => {
      state.done = true;
    })
    .catch(() => undefined);

  return state;
};

it('stops waiting for the agent session when the task is aborted', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const handle = workerHandle();

  const identity = waitForPiIdentity(handle, herdr(pendingSession));

  const state = settled(identity);

  await vi.advanceTimersByTimeAsync(100);
  handle.abort.abort();
  await vi.advanceTimersByTimeAsync(10);

  expect(state.done).toBe(true);
  expect(String(state.failure)).toContain('integration');
});

it('ends the wait with the pending-session error when the startup budget is gone', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const handle = workerHandle();

  handle.expires = performance.now() + 100;

  const identity = waitForPiIdentity(handle, herdr(pendingSession));

  const failure = identity.catch((error: unknown) => error);

  await vi.advanceTimersByTimeAsync(1000);

  expect(String(await failure)).toContain('integration');
});

const recordedHandle = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-readiness-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return workerHandle(directory);
};

it('returns the ready event once the worker is ready', async () => {
  const handle = recordedHandle();

  recordEvent(handle.directory, 'task', 'ready', 'Ready.');

  await expect(waitForWorkerReadiness(handle, herdr())).resolves.toMatchObject({
    kind: 'ready',
  });
});

it('fails readiness with the startup failure detail even when a ready event exists', async () => {
  const handle = recordedHandle();

  recordEvent(handle.directory, 'task', 'ready', 'Ready.');
  recordEvent(handle.directory, 'task', 'startupFailure', 'Extension failed to load.');

  await expect(waitForWorkerReadiness(handle, herdr())).rejects.toThrow(
    'Extension failed to load.',
  );
});

it('fails readiness at once for an aborted task even when a ready event exists', async () => {
  const handle = recordedHandle();

  recordEvent(handle.directory, 'task', 'ready', 'Ready.');
  handle.abort.abort();

  await expect(waitForWorkerReadiness(handle, herdr())).rejects.toThrow('aborted');
});

it('stops waiting for readiness when the task is aborted', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const handle = recordedHandle();
  const readiness = waitForWorkerReadiness(handle, herdr());
  const state = settled(readiness);

  await vi.advanceTimersByTimeAsync(100);
  handle.abort.abort();
  await vi.advanceTimersByTimeAsync(10);

  expect(state.done).toBe(true);
  expect(String(state.failure)).toContain('aborted');
});

it('matches a herdr error code on the error or any cause', () => {
  expect(isHerdrError(herdrError('agent_not_found'), 'agent_not_found')).toBe(true);
  expect(isHerdrError(herdrError('agent_not_found', true), 'agent_not_found')).toBe(true);
  expect(isHerdrError(herdrError('pane_not_found'), 'agent_not_found')).toBe(false);
  expect(isHerdrError(herdrError('pane_not_found', true), 'agent_not_found')).toBe(false);
  expect(isHerdrError(new Error('plain'), 'agent_not_found')).toBe(false);
  expect(isHerdrError('agent_not_found', 'agent_not_found')).toBe(false);
});
