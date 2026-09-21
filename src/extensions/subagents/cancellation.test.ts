import { expect, it, vi, onTestFinished } from 'vitest';

import { cancelOwnedWorker, matchesWorker } from './cancellation.js';
import { agentResponse, paneListResponse, processInfoResponse } from './fixtures/herdrFake.js';

it('resolves moved terminal identity before sending cancellation keys', async () => {
  const calls: string[][] = [];
  const owned = {
    kind: 'pi' as const,
    paneId: 'old:pane',
    terminalId: 'terminal',
    shellPid: 1,
    processId: process.pid,
    token: '/tmp/moved-session',
  };
  const client = async (argumentsList: string[]) => {
    calls.push(argumentsList);

    if (argumentsList[1] === 'list') {
      return paneListResponse([
        {
          pane_id: 'new:pane',
          terminal_id: 'terminal',
          workspace_id: 'new',
          tab_id: 'new:tab',
        },
      ]);
    }

    if (argumentsList[1] === 'get') {
      return agentResponse({
        pane_id: 'new:pane',
        agent: 'pi',
        agent_session: { value: owned.token },
      });
    }

    if (argumentsList[1] === 'process-info') {
      return processInfoResponse({
        paneId: 'new:pane',
        shellPid: 1,
        processId: process.pid,
        argv: ['pi', owned.token],
      });
    }

    throw new Error('Input delivery uncertain');
  };
  const result = await cancelOwnedWorker(owned, 1000, client, new AbortController().signal);

  expect(calls.filter((call) => call[1] === 'send-keys')).toEqual([
    ['agent', 'send-keys', 'new:pane', 'escape', 'ctrl+c', 'ctrl+d'],
  ]);
  expect(result.cleanup).toBe('unconfirmed');
  expect(calls.flat()).not.toContain('old:pane');
});

it('follows a second move while confirming cancellation without sending input twice', async () => {
  const calls: string[][] = [];
  let paneId = 'first:pane';
  let stopped = false;
  const owned = {
    kind: 'process' as const,
    paneId: 'old:pane',
    terminalId: 'terminal',
    shellPid: 100,
    processId: 101,
    token: '/tmp/worker',
  };
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const client = async (argumentsList: string[]) => {
    calls.push(argumentsList);

    if (argumentsList[1] === 'list') {
      return paneListResponse([
        {
          pane_id: paneId,
          terminal_id: owned.terminalId,
          workspace_id: 'workspace',
          tab_id: 'tab',
        },
      ]);
    }

    if (argumentsList[1] === 'send-keys') {
      paneId = 'second:pane';
      stopped = true;

      return '{}';
    }

    const processId = stopped ? owned.shellPid : owned.processId;

    return processInfoResponse({
      paneId: paneId,
      shellPid: owned.shellPid,
      processId: processId,
      argv: [owned.token],
    });
  };
  const result = await cancelOwnedWorker(owned, 1000, client, new AbortController().signal);

  expect(result.cleanup).toBe('confirmed');
  expect(calls.filter((call) => call[1] === 'send-keys')).toEqual([
    ['pane', 'send-keys', 'first:pane', 'ctrl+c'],
  ]);
  expect(calls.at(-1)).toEqual(['pane', 'process-info', '--pane', 'second:pane']);
});

it.each(['missing', 'duplicate', 'changed before input'] as const)(
  'refuses %s terminal ownership before cancellation input',
  async (scenario) => {
    let inventories = 0;
    const calls: string[][] = [];
    const owned = {
      kind: 'process' as const,
      paneId: 'old:pane',
      terminalId: 'terminal',
      shellPid: 100,
      processId: 101,
      token: '/tmp/worker',
    };
    const client = async (argumentsList: string[]) => {
      calls.push(argumentsList);

      if (argumentsList[1] === 'list') {
        const pane = {
          pane_id: ++inventories === 1 ? 'first:pane' : 'second:pane',
          terminal_id: owned.terminalId,
          workspace_id: 'workspace',
          tab_id: 'tab',
        };
        const panes = scenario === 'missing' ? [] : [pane];

        if (scenario === 'duplicate') {
          panes.push({ ...pane, pane_id: 'duplicate' });
        }

        return JSON.stringify({ result: { panes } });
      }

      return processInfoResponse({
        paneId: 'first:pane',
        shellPid: owned.shellPid,
        processId: owned.processId,
        argv: [owned.token],
      });
    };
    const result = await cancelOwnedWorker(owned, 1000, client, new AbortController().signal);

    expect(result.cleanup).toBe('refused');
    expect(calls.some((call) => call[1] === 'send-keys' || call[1] === 'close')).toBe(false);
  },
);

it('reports identity loss after cancellation input as unconfirmed', async () => {
  let sent = false;
  const owned = {
    kind: 'process' as const,
    paneId: 'pane',
    terminalId: 'terminal',
    shellPid: 100,
    processId: 101,
    token: '/tmp/worker',
  };
  const client = async (argumentsList: string[]) => {
    if (argumentsList[1] === 'list') {
      const pane = { pane_id: 'pane', terminal_id: 'terminal', workspace_id: 'w', tab_id: 't' };

      return JSON.stringify({ result: { panes: sent ? [] : [pane] } });
    }

    if (argumentsList[1] === 'send-keys') {
      sent = true;

      return '{}';
    }

    return processInfoResponse({
      paneId: 'pane',
      shellPid: owned.shellPid,
      processId: owned.processId,
      argv: [owned.token],
    });
  };

  const result = await cancelOwnedWorker(owned, 1000, client, new AbortController().signal);

  expect(sent).toBe(true);
  expect(result.cleanup).toBe('unconfirmed');
});

it('requests active Pi abort before attempting editor shutdown without claiming it stopped', async () => {
  const calls: string[][] = [];
  const owned = {
    kind: 'pi' as const,
    paneId: 'owned',
    terminalId: 'owned-terminal',
    shellPid: 1,
    processId: process.pid,
    token: '/tmp/unique-session.jsonl',
  };
  const client = async (argumentsList: string[]) => {
    calls.push(argumentsList);

    if (argumentsList[1] === 'list') {
      return paneListResponse([
        {
          pane_id: owned.paneId,
          terminal_id: owned.terminalId,
          workspace_id: 'workspace',
          tab_id: 'tab',
        },
      ]);
    }

    if (argumentsList[1] === 'get') {
      return agentResponse({
        pane_id: 'owned',
        agent: 'pi',
        agent_session: { value: owned.token },
      });
    }

    if (argumentsList[1] === 'process-info') {
      return processInfoResponse({
        paneId: 'owned',
        shellPid: 1,
        processId: process.pid,
        argv: ['pi', owned.token],
      });
    }

    throw new Error('Injected unavailable terminal input.');
  };
  const result = await cancelOwnedWorker(owned, 100, client, new AbortController().signal);

  expect(calls.filter((call) => call[1] === 'send-keys')).toEqual([
    ['agent', 'send-keys', 'owned', 'escape', 'ctrl+c', 'ctrl+d'],
  ]);
  expect(result.cleanup).toBe('unconfirmed');
  expect(result.detail).toContain('manual cleanup');
});

it('matches a Pi worker by start time when herdr omits its argv', () => {
  const information = {
    pane_id: 'pane',
    shell_pid: 100,
    foreground_process_group_id: 101,
    foreground_processes: [{ name: 'pi', pid: 101 }],
  };
  const worker = { paneId: 'pane', terminalId: 'terminal', shellPid: 100, processId: 101 };

  expect(
    matchesWorker(information, {
      ...worker,
      kind: 'pi',
      token: '/tmp/session',
      startedAt: 'Mon Sep 21 10:43:04 2026',
    }),
  ).toBe(true);
  expect(matchesWorker(information, { ...worker, kind: 'process', token: '/tmp/worker' })).toBe(
    false,
  );
});

it('confirms a worker that exits during identity checks without sending input', async () => {
  const calls: string[][] = [];
  const owned = {
    kind: 'process' as const,
    paneId: 'pane',
    terminalId: 'terminal',
    shellPid: 100,
    processId: 101,
    token: '/tmp/worker',
  };
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const client = async (argumentsList: string[]) => {
    calls.push(argumentsList);

    if (argumentsList[1] === 'list') {
      return paneListResponse([
        { pane_id: 'pane', terminal_id: 'terminal', workspace_id: 'workspace', tab_id: 'tab' },
      ]);
    }

    return processInfoResponse({
      paneId: 'pane',
      shellPid: owned.shellPid,
      processId: owned.shellPid,
      argv: ['zsh'],
    });
  };
  const result = await cancelOwnedWorker(owned, 1000, client, new AbortController().signal);

  expect(result.cleanup).toBe('confirmed');
  expect(calls.some((call) => call[1] === 'send-keys')).toBe(false);
});
