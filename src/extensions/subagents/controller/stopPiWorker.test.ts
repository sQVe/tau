import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as cancellation from '../cancellation.js';
import { agentResponse, paneListResponse, processInfoResponse } from '../fixtures/herdrFake.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import { WorkerPlacement } from '../placement.js';
import type { Task } from '../types.js';
import { stopPiWorker } from './stop.js';
import { createHandle } from './task.js';

type Pane = Record<'pane_id' | 'terminal_id' | 'workspace_id' | 'tab_id', string>;

interface World {
  // Panes herdr lists on the n-th `pane list` call, counted from 1.
  panes: (listCall: number) => Pane[];
  // The `pane process-info` reply for a pane.
  processInfo?: (paneId: string) => string;
  // The identity checks of an owned worker run this on each `pane process-info` call.
  onProcessInfo?: () => void;
  onList?: () => void;
}

const token = '/tmp/worker-session.jsonl';
const processId = 4242;

const pane = (name: string): Pane => ({
  pane_id: name,
  terminal_id: `${name}-terminal`,
  workspace_id: 'w',
  tab_id: 't',
});

const sessionProcess = (paneId: string, argv = ['pi', token]): string =>
  processInfoResponse({ paneId, shellPid: processId, processId, argv });

const herdr = (world: World) => {
  const calls: string[][] = [];
  const closedPanes = new Set<string>();
  let listCalls = 0;

  const call = async (argumentsList: string[]): Promise<string> => {
    calls.push(argumentsList);
    const [surface, action, target] = argumentsList;

    if (surface === 'pane' && action === 'list' && argumentsList.length === 2) {
      listCalls += 1;
      world.onList?.();

      const listed = world.panes(listCalls).filter((entry) => !closedPanes.has(entry.pane_id));

      return paneListResponse(listed);
    }

    if (surface === 'pane' && action === 'process-info' && argumentsList[2] === '--pane') {
      world.onProcessInfo?.();

      return (world.processInfo ?? ((name) => sessionProcess(name)))(argumentsList[3] ?? '');
    }

    if (surface === 'pane' && action === 'close') {
      closedPanes.add(target ?? '');

      return '{}';
    }

    if (surface === 'pane' && action === 'get') {
      return JSON.stringify({ result: { pane: pane(target ?? '') } });
    }

    if (surface === 'agent' && action === 'get') {
      return agentResponse({
        pane_id: target,
        agent: 'pi',
        agent_session: { value: token },
      });
    }

    throw new Error(`Unexpected herdr call: ${argumentsList.join(' ')}`);
  };

  return { call, calls, closed: () => calls.filter((entry) => entry[1] === 'close') };
};

const newHandle = () => {
  const task = { taskId: 'task', nativeSessionFile: token, loadout: fixtureLoadout('/tmp') };
  const handle = createHandle('/tmp/task', task as Task, performance.now() + 60_000);

  handle.startup.neverStarted = false;

  return handle;
};

const ownedHandle = () => {
  const handle = newHandle();

  handle.identity.terminalId = 'pane-terminal';

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

  return handle;
};

const unownedHandle = () => {
  const handle = newHandle();

  handle.identity.terminalId = 'pane-terminal';

  return handle;
};

const lostReplyHandle = (before: string[] = []) => {
  const handle = newHandle();

  handle.startup.terminalsBeforeLaunch = before;

  return handle;
};

const stop = (
  handle: ReturnType<typeof newHandle>,
  call: (argumentsList: string[]) => Promise<string>,
  options: {
    graceful?: boolean;
    placement?: WorkerPlacement;
    signal?: AbortSignal;
  } = {},
) =>
  stopPiWorker({
    handle,
    call,
    remainingBudget: () => 5000,
    signal: options.signal ?? AbortSignal.timeout(5000),
    placement: options.placement ?? new WorkerPlacement(),
    graceful: options.graceful ?? false,
  });

beforeEach(() => {
  vi.spyOn(cancellation, 'runClient').mockResolvedValue('saved start');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('refuses to close a pane when the worker moved during the identity checks', async () => {
  const moved = { ...pane('moved'), terminal_id: 'pane-terminal' };
  const world = herdr({ panes: (listCall) => [listCall === 1 ? pane('pane') : moved] });

  const outcome = await stop(unownedHandle(), world.call);

  expect(outcome.stopped).toBe(false);
  expect(world.closed()).toEqual([]);
});

it('refuses a pane whose process info names another pane', async () => {
  const world = herdr({
    panes: () => [pane('pane')],
    processInfo: () => sessionProcess('another-pane'),
  });

  const outcome = await stop(unownedHandle(), world.call);

  expect(outcome.stopped).toBe(false);
  expect(world.closed()).toEqual([]);
});

it('refuses a pane whose session runs in a process other than the shell', async () => {
  const response = JSON.stringify({
    result: {
      process_info: {
        pane_id: 'pane',
        shell_pid: processId,
        foreground_processes: [
          { pid: 1, argv: ['pi', token] },
          { pid: processId, argv: ['pi'] },
        ],
      },
    },
  });

  const world = herdr({ panes: () => [pane('pane')], processInfo: () => response });

  const outcome = await stop(unownedHandle(), world.call);

  expect(outcome.stopped).toBe(false);
  expect(world.closed()).toEqual([]);
});

it('closes the new pane that runs the session after a lost launch reply', async () => {
  const world = herdr({
    panes: () => [pane('old'), pane('other'), pane('launched')],
    processInfo: (name) =>
      name === 'launched' ? sessionProcess(name) : sessionProcess(name, ['pi', 'elsewhere']),
  });

  const outcome = await stop(lostReplyHandle(['old-terminal']), world.call);

  expect(outcome.stopped).toBe(true);
  expect(world.closed()).toEqual([['pane', 'close', 'launched']]);
});

it('skips a new pane whose process info is unreadable after a lost launch reply', async () => {
  const world = herdr({
    panes: () => [pane('unreadable'), pane('launched')],
    processInfo: (name) => {
      if (name === 'unreadable') {
        throw new Error('process-info failed');
      }

      return sessionProcess(name);
    },
  });

  const outcome = await stop(lostReplyHandle(), world.call);

  expect(outcome.stopped).toBe(true);
  expect(world.closed()).toEqual([['pane', 'close', 'launched']]);
});

it.each([
  [
    'has no foreground process for the shell',
    JSON.stringify({
      result: {
        process_info: {
          pane_id: 'pane',
          shell_pid: processId,
          foreground_processes: [{ pid: 1, argv: ['pi', token] }],
        },
      },
    }),
  ],
  [
    'has no argument list',
    JSON.stringify({
      result: {
        process_info: {
          pane_id: 'pane',
          shell_pid: processId,
          foreground_processes: [{ pid: processId }],
        },
      },
    }),
  ],
  ['names another pane', sessionProcess('another-pane')],
])('leaves a new pane alone when its process info %s', async (_name, response) => {
  const world = herdr({ panes: () => [pane('pane')], processInfo: () => response });

  const outcome = await stop(lostReplyHandle(), world.call);

  expect(outcome.stopped).toBe(false);
  expect(world.closed()).toEqual([]);
});

it('reports an unlocated worker when no terminals were recorded before the launch', async () => {
  const world = herdr({ panes: () => [pane('pane')] });

  const outcome = await stop(newHandle(), world.call);

  expect(outcome.stopped).toBe(false);
  expect(world.closed()).toEqual([]);
});

const heldPlacement = (afterGate?: () => void) => {
  const placement = new WorkerPlacement();
  const release = Promise.withResolvers<undefined>();

  const held = placement.close(async () => {
    await release.promise;
    afterGate?.();
  });

  return {
    placement,
    held,
    release: () => {
      release.resolve(undefined);
    },
  };
};

it('does not wait for the placement queue when no worker was ever started', async () => {
  const { placement, held, release } = heldPlacement();
  const handle = newHandle();

  handle.startup.neverStarted = true;

  const outcome = stop(handle, herdr({ panes: () => [] }).call, { placement });

  expect(await outcome).toMatchObject({ stopped: true });
  release();
  await held;
});

it('does not wait for the placement queue when the worker terminal is known', async () => {
  vi.spyOn(cancellation, 'processAbsent').mockReturnValue(true);
  const { placement, held, release } = heldPlacement();
  const world = herdr({ panes: () => [] });

  const outcome = stop(ownedHandle(), world.call, { placement });

  expect(await outcome).toMatchObject({ stopped: true });
  release();
  await held;
});

it('waits for an in-flight launch to record its pane before it stops the worker', async () => {
  const world = herdr({ panes: () => [pane('pane')] });
  const handle = newHandle();

  // The in-flight launch records its pane when its placement step finishes.
  const { placement, held, release } = heldPlacement(() => {
    handle.identity.paneId = 'pane';
  });

  const outcome = stop(handle, world.call, { placement });

  release();
  await held;

  expect(await outcome).toMatchObject({ stopped: true });
  expect(world.closed()).toEqual([['pane', 'close', 'pane']]);
});

it('keeps an owned worker alive through its grace period, then closes its pane', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const started = performance.now();
  let closedAt = 0;

  const world = herdr({ panes: () => [pane('pane')] });

  const call = async (argumentsList: string[]) => {
    if (argumentsList[1] === 'close') {
      closedAt = performance.now() - started;
    }

    return world.call(argumentsList);
  };

  const stopping = stop(unownedHandle(), call, { graceful: true });

  await vi.advanceTimersByTimeAsync(2000);
  const outcome = await stopping;

  expect(outcome.stopped).toBe(true);
  expect(closedAt).toBeGreaterThanOrEqual(1000);
});

it('does not close the pane of a worker that exits during its grace period', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let exited = false;
  const processExists = vi.spyOn(cancellation, 'processAbsent');

  processExists.mockImplementation(() => exited);

  const world = herdr({ panes: () => (exited ? [] : [pane('pane')]) });

  const call = async (argumentsList: string[]) => {
    // The worker exits when the second poll starts.
    exited = world.calls.some((entry) => entry[1] === 'list');

    return world.call(argumentsList);
  };

  const stopping = stop(ownedHandle(), call, { graceful: true });

  await vi.advanceTimersByTimeAsync(2000);
  const outcome = await stopping;

  expect(outcome.stopped).toBe(true);
  expect(world.closed()).toEqual([]);
});

it('confirms a closed worker whose process lingers briefly after its pane is gone', async () => {
  let closed = false;
  let checksAfterClose = 0;

  vi.spyOn(cancellation, 'processAbsent').mockImplementation(() => {
    if (!closed) {
      return false;
    }

    checksAfterClose += 1;

    return checksAfterClose > 3;
  });

  const world = herdr({ panes: () => (closed ? [] : [pane('pane')]) });

  const call = async (argumentsList: string[]) => {
    const response = await world.call(argumentsList);

    if (argumentsList[1] === 'close') {
      closed = true;
    }

    return response;
  };

  const outcome = await stop(ownedHandle(), call);

  expect(outcome.stopped).toBe(true);
  expect(world.closed()).toEqual([['pane', 'close', 'pane']]);
});

it('reports a vanished pane whose process still runs as needing manual cleanup', async () => {
  vi.spyOn(cancellation, 'processAbsent').mockReturnValue(false);

  const world = herdr({ panes: () => [] });

  const outcome = await stop(ownedHandle(), world.call);

  expect(outcome.stopped).toBe(false);
  expect(world.closed()).toEqual([]);
});

it('confirms a worker that exits while its identity is checked', async () => {
  let exited = false;

  vi.spyOn(cancellation, 'processAbsent').mockImplementation(() => exited);

  const world = herdr({
    panes: () => (exited ? [] : [pane('pane')]),
    onProcessInfo: () => {
      exited = true;
      throw new Error('process-info failed');
    },
  });

  const outcome = await stop(ownedHandle(), world.call);

  expect(outcome.stopped).toBe(true);
  expect(world.closed()).toEqual([]);
});

it('stops waiting for the grace period when the stop is aborted', async () => {
  const abort = new AbortController();
  let listings = 0;

  const world = herdr({
    panes: () => [pane('pane')],
    onList: () => {
      listings += 1;
      abort.abort();
    },
  });

  const outcome = await stop(unownedHandle(), world.call, {
    graceful: true,
    signal: abort.signal,
  });

  expect(outcome.stopped).toBe(false);
  expect(listings).toBe(1);
  expect(world.closed()).toEqual([]);
});
