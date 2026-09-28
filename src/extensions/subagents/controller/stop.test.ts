import { afterEach, expect, it, vi } from 'vitest';

import * as cancellation from '../cancellation.js';
import { agentResponse, paneListResponse, processInfoResponse } from '../fixtures/herdrFake.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import { WorkerPlacement } from '../placement.js';
import type { Task } from '../types.js';
import { stopPiWorker } from './stop.js';
import { createHandle } from './task.js';

type Scenario =
  | 'matching'
  | 'rewritten argv'
  | 'wrong session'
  | 'changed start'
  | 'replaced process'
  | 'wrong pane'
  | 'unowned with session'
  | 'unowned without session'
  | 'lost launch reply'
  | 'two panes on the session'
  | 'older pane on the session'
  | 'exited before its terminal was read';

const token = '/tmp/worker-session.jsonl';
const processId = 4242;

afterEach(() => {
  vi.restoreAllMocks();
});

const stopScenario = async (scenario: Scenario) => {
  const task = { taskId: 'task', nativeSessionFile: token, loadout: fixtureLoadout('/tmp') };
  const handle = createHandle('/tmp/task', task as Task, performance.now() + 1000);
  const calls: string[][] = [];
  let present = true;

  const lostReply = [
    'lost launch reply',
    'two panes on the session',
    'older pane on the session',
    'exited before its terminal was read',
  ].includes(scenario);

  handle.startup.neverStarted = false;

  // herdr reported the launched pane, but it closed before Tau read its terminal.
  if (scenario === 'exited before its terminal was read') {
    handle.identity.paneId = 'pane';
    present = false;
  }

  if (lostReply) {
    handle.startup.terminalsBeforeLaunch =
      scenario === 'older pane on the session' ? ['terminal'] : ['parent-terminal'];
  } else {
    handle.identity.terminalId = 'terminal';
  }

  if (!scenario.startsWith('unowned') && !lostReply) {
    handle.identity.owned = {
      version: 2,
      kind: 'pi',
      paneId: 'pane',
      terminalId: 'terminal',
      shellPid: processId,
      processId,
      token,
      startedAt: 'saved start',
    };
  }

  vi.spyOn(cancellation, 'runClient').mockResolvedValue(
    scenario === 'changed start' ? 'another start' : 'saved start',
  );

  // The pane's process ends when herdr closes the pane.
  vi.spyOn(cancellation, 'processAbsent').mockImplementation(() => !present);

  const call = async (argumentsList: string[]) => {
    calls.push(argumentsList);
    const [surface, action] = argumentsList;

    if (surface === 'pane' && action === 'list') {
      const pane = { pane_id: 'pane', terminal_id: 'terminal', workspace_id: 'w', tab_id: 't' };
      const other = { ...pane, pane_id: 'other', terminal_id: 'other-terminal' };

      return paneListResponse(
        present ? [pane, ...(scenario === 'two panes on the session' ? [other] : [])] : [],
      );
    }

    if (action === 'process-info') {
      const root = scenario === 'replaced process' ? 999 : processId;

      const paneId = argumentsList[argumentsList.indexOf('--pane') + 1];

      return processInfoResponse({
        paneId: scenario === 'wrong pane' ? 'another-pane' : paneId,
        shellPid: root,
        processId: root,
        argv: [
          'pi',
          ...(['rewritten argv', 'unowned without session'].includes(scenario) ? [] : [token]),
        ],
      });
    }

    if (surface === 'agent' && action === 'get') {
      return agentResponse({
        pane_id: 'pane',
        agent: 'pi',
        agent_session: { value: scenario === 'wrong session' ? '/tmp/another.jsonl' : token },
      });
    }

    if (action === 'close') {
      present = false;

      return '{}';
    }

    if (action === 'get') {
      throw Object.assign(new Error('pane not found'), {
        stderr: JSON.stringify({ error: { code: 'pane_not_found' } }),
      });
    }

    throw new Error(`Unexpected herdr call: ${argumentsList.join(' ')}`);
  };

  const stop = await stopPiWorker({
    handle,
    call,
    remainingBudget: () => 1000,
    signal: AbortSignal.timeout(1000),
    placement: new WorkerPlacement(),
    graceful: false,
  });

  return {
    stopped: stop.stopped,
    closed: calls.some((argumentsList) => argumentsList[1] === 'close'),
  };
};

it.each([
  ['matching', true],
  // herdr may report a rewritten process title; the saved start time still identifies Pi.
  ['rewritten argv', true],
  ['wrong session', false],
  ['changed start', false],
  ['replaced process', false],
  ['wrong pane', false],
  ['unowned with session', true],
  ['unowned without session', false],
  // A lost launch reply leaves no pane ID; the one pane running the session is the worker.
  ['lost launch reply', true],
  ['two panes on the session', false],
  // A follow-up shares its predecessor's session; a pane from before the launch is never the worker.
  ['older pane on the session', false],
] as const)('closes a Pi worker pane with %s identity: %s', async (scenario, closes) => {
  expect(await stopScenario(scenario)).toEqual({ stopped: closes, closed: closes });
});

it('confirms a worker whose pane closed before Tau read its terminal', async () => {
  expect(await stopScenario('exited before its terminal was read')).toEqual({
    stopped: true,
    closed: false,
  });
});
