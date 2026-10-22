import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import {
  agentResponse,
  paneListResponse,
  processInfoResponse,
} from '../../../../tests/herdrFake.js';
import * as cancellation from '../cancellation.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import { recordEvent } from '../records.js';
import type { Task } from '../types.js';
import { isHerdrError, waitForPiIdentity, waitForWorkerReadiness } from './inspect.js';
import { createHandle } from './task.js';

type AgentReply = (agentCall: number) => string;

vi.mock(import('node:timers/promises'), async (importOriginal) => ({
  ...(await importOriginal()),
  setTimeout: (await import('./fixtures/globalTimerDelay.js')).globalTimerDelay,
}));

const token = '/tmp/worker-session.jsonl';
const processId = 4242;

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

  handle.identity.terminalId = 'pane-terminal';
  handle.startup.neverStarted = false;

  if (owned) {
    handle.identity.owned = {
      version: 2,
      kind: 'pi',
      paneId: 'pane',
      terminalId: 'pane-terminal',
      shellPid: processId,
      processId,
      token,
      startedAt: 'saved start',
    };
  }

  return handle;
};

const readyAgent = (): string =>
  agentResponse({
    pane_id: 'pane',
    agent: 'pi',
    agent_session: { kind: 'path', value: token },
  });

const sessionAgent = (session: unknown): string =>
  agentResponse({ pane_id: 'pane', agent: 'pi', agent_session: session });

const herdr = (agent: AgentReply) => {
  let agentCalls = 0;

  return async (argumentsList: string[]): Promise<string> => {
    const [surface, action] = argumentsList;

    if (surface === 'pane' && action === 'list' && argumentsList.length === 2) {
      return paneListResponse([
        { pane_id: 'pane', terminal_id: 'pane-terminal', workspace_id: 'w', tab_id: 't' },
      ]);
    }

    if (surface === 'pane' && action === 'process-info' && argumentsList[2] === '--pane') {
      return processInfoResponse({
        paneId: argumentsList[3],
        shellPid: processId,
        processId,
        argv: ['pi', token],
      });
    }

    if (surface === 'agent' && action === 'get') {
      agentCalls += 1;

      if (agentCalls > agentCallLimit) {
        throw new Error('The test stopped polling.');
      }

      return agent(agentCalls);
    }

    throw new Error(`Unexpected herdr call: ${argumentsList.join(' ')}`);
  };
};

it('identifies a Pi worker whose pane, session, and process agree', async () => {
  const owned = await waitForPiIdentity(workerHandle(), herdr(readyAgent));

  expect(owned).toMatchObject({ paneId: 'pane', terminalId: 'pane-terminal', shellPid: processId });
});

it.each([
  ['no session yet', undefined],
  ['a null session', null],
])('keeps polling while herdr reports %s', async (_name, session) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const identity = waitForPiIdentity(
    workerHandle(),
    herdr((agentCall) => (agentCall < 3 ? sessionAgent(session) : readyAgent())),
  );

  await vi.advanceTimersByTimeAsync(600);

  expect(await identity).toMatchObject({ paneId: 'pane' });
});

it.each([
  ['an empty session value', { value: '' }],
  ['a session that is not an object', 'session'],
])('fails at once on %s', async (_name, session) => {
  await expect(
    waitForPiIdentity(
      workerHandle(),
      herdr(() => sessionAgent(session)),
    ),
  ).rejects.toThrow('integration');
});

it('keeps polling while herdr has not detected the agent of a new worker', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const identity = waitForPiIdentity(
    workerHandle(),
    herdr((agentCall) => {
      if (agentCall < 3) {
        throw herdrError('agent_not_found');
      }

      return readyAgent();
    }),
  );

  await vi.advanceTimersByTimeAsync(600);

  expect(await identity).toMatchObject({ paneId: 'pane' });
});

it('does not wait for the agent of a worker that Tau already identified', async () => {
  await expect(
    waitForPiIdentity(
      workerHandle('/tmp/task', true),
      herdr(() => {
        throw herdrError('agent_not_found');
      }),
    ),
  ).rejects.toSatisfy((error) => isHerdrError(error, 'agent_not_found'));
});

it('fails at once on a herdr error other than a missing agent', async () => {
  await expect(
    waitForPiIdentity(
      workerHandle(),
      herdr(() => {
        throw herdrError('pane_not_found');
      }),
    ),
  ).rejects.toSatisfy((error) => isHerdrError(error, 'pane_not_found'));
});

it('rejects a pane whose agent is not Pi', async () => {
  await expect(
    waitForPiIdentity(
      workerHandle(),
      herdr(() =>
        agentResponse({ pane_id: 'pane', agent: 'claude', agent_session: { value: token } }),
      ),
    ),
  ).rejects.toThrow('identity');
});

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

  const identity = waitForPiIdentity(
    handle,
    herdr(() => sessionAgent(undefined)),
  );

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

  const identity = waitForPiIdentity(
    handle,
    herdr(() => sessionAgent(undefined)),
  );

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

  await expect(waitForWorkerReadiness(handle, herdr(readyAgent))).resolves.toMatchObject({
    kind: 'ready',
  });
});

it('fails readiness with the startup failure detail even when a ready event exists', async () => {
  const handle = recordedHandle();

  recordEvent(handle.directory, 'task', 'ready', 'Ready.');
  recordEvent(handle.directory, 'task', 'startupFailure', 'Extension failed to load.');

  await expect(waitForWorkerReadiness(handle, herdr(readyAgent))).rejects.toThrow(
    'Extension failed to load.',
  );
});

it('fails readiness at once for an aborted task even when a ready event exists', async () => {
  const handle = recordedHandle();

  recordEvent(handle.directory, 'task', 'ready', 'Ready.');
  handle.abort.abort();

  await expect(waitForWorkerReadiness(handle, herdr(readyAgent))).rejects.toThrow('aborted');
});

it('stops waiting for readiness when the task is aborted', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const handle = recordedHandle();
  const readiness = waitForWorkerReadiness(handle, herdr(readyAgent));
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
