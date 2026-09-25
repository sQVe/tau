import { spawn } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import * as timeout from './cancellation.js';
import { agentResponse, paneListResponse, processInfoResponse } from './fixtures/herdrFake.js';

type Client = Parameters<typeof timeout.cancelOwnedWorker>[2];

const owned = {
  kind: 'process' as const,
  paneId: 'w1:p2',
  terminalId: 'owned-terminal',
  shellPid: 100,
  processId: 101,
  token: '/tmp/owned-session.jsonl',
};

const snapshot = (processId = owned.processId, token = owned.token) =>
  processInfoResponse({
    paneId: owned.paneId,
    shellPid: owned.shellPid,
    processId: processId,
    argv: ['pi', '--session', token],
  });

const shell = () => snapshot(owned.shellPid);

const spawnShell = () =>
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

const processStart = async (pid: number) =>
  (await timeout.runClient('ps', ['-p', String(pid), '-o', 'lstart='], 1000)).trim();

const genericOwned = async (shellPid: number) => {
  return {
    kind: 'generic' as const,
    paneId: owned.paneId,
    terminalId: owned.terminalId,
    shellPid,
    processId: process.pid,
    agentKind: 'codex',
    startedAt: await processStart(process.pid),
    shellStartedAt: await processStart(shellPid),
    nativeReference: { kind: 'codex-session', value: 'session-value' },
  };
};

const genericSnapshot = (
  worker: { paneId: string; shellPid: number; processId: number },
  processId = worker.processId,
) =>
  processInfoResponse({
    paneId: worker.paneId,
    shellPid: worker.shellPid,
    processId: processId,
    argv: ['codex'],
  });

const shellSnapshot = (worker: { paneId: string; shellPid: number }) =>
  JSON.stringify({
    result: {
      process_info: {
        pane_id: worker.paneId,
        shell_pid: worker.shellPid,
        foreground_process_group_id: worker.shellPid,
        foreground_processes: [],
      },
    },
  });

const withInventory =
  (client: Client): Client =>
  async (argumentsList, budget, signal) => {
    if (argumentsList[1] === 'list') {
      return paneListResponse([
        {
          pane_id: owned.paneId,
          terminal_id: owned.terminalId,
          workspace_id: 'w1',
          tab_id: 'w1:t1',
        },
      ]);
    }

    return client(argumentsList, budget, signal);
  };

describe('owned worker cancellation', () => {
  beforeEach(() => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Process absent'), { code: 'ESRCH' });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses Pi clear then exit keys instead of a terminal interrupt', async () => {
    const recognized = agentResponse({
      pane_id: owned.paneId,
      agent: 'pi',
      agent_session: { value: owned.token },
    });

    const client = vi
      .fn<Client>()
      .mockResolvedValueOnce(recognized)
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce('{}')
      .mockResolvedValue(shell());

    const result = await timeout.cancelOwnedWorker(
      { ...owned, kind: 'pi' },
      200,
      withInventory(client),
      new AbortController().signal,
    );

    expect(result.cleanup).toBe('confirmed');

    expect(client).toHaveBeenCalledWith(
      ['agent', 'send-keys', owned.paneId, 'escape', 'ctrl+c', 'ctrl+d'],
      expect.any(Number),
      expect.any(AbortSignal),
    );
  });

  it.each([
    'rewritten argv',
    'wrong session',
    'changed start',
    'wrong pane',
    'wrong shell',
    'wrong foreground',
    'wrong process entry',
  ])('checks alternative Pi identity with %s', async (scenario) => {
    const startedAt = (
      await timeout.runClient('ps', ['-p', String(process.pid), '-o', 'lstart='], 1000)
    ).trim();

    const piOwned = {
      ...owned,
      kind: 'pi' as const,
      processId: process.pid,
      startedAt: scenario === 'changed start' ? 'previous process' : startedAt,
    };

    const client = vi.fn<Client>(async (argumentsList) => {
      if (argumentsList[1] === 'get') {
        return JSON.stringify({
          result: {
            agent: {
              pane_id: owned.paneId,
              agent: 'pi',
              agent_session: {
                value: scenario === 'wrong session' ? '/tmp/another-session' : owned.token,
              },
            },
          },
        });
      }

      if (argumentsList[1] === 'send-keys') {
        return '{}';
      }

      if (client.mock.calls.some(([call]) => call[1] === 'send-keys')) {
        return shell();
      }

      return JSON.stringify({
        result: {
          process_info: {
            pane_id: scenario === 'wrong pane' ? 'another-pane' : owned.paneId,
            shell_pid: scenario === 'wrong shell' ? 999 : owned.shellPid,
            foreground_process_group_id: scenario === 'wrong foreground' ? 999 : process.pid,
            foreground_processes: [
              {
                pid: scenario === 'wrong process entry' ? 999 : process.pid,
                argv: ['pi rewritten title'],
              },
            ],
          },
        },
      });
    });

    const result = await timeout.cancelOwnedWorker(
      piOwned,
      1000,
      withInventory(client),
      new AbortController().signal,
    );

    const sent = client.mock.calls.filter(([argumentsList]) => argumentsList[1] === 'send-keys');

    expect(result.cleanup).toBe(scenario === 'rewritten argv' ? 'confirmed' : 'refused');
    expect(sent).toHaveLength(scenario === 'rewritten argv' ? 1 : 0);
  });

  it.each(['foreground', 'session'] as const)(
    'stops repeated generic interrupts after %s identity changes',
    async (changed) => {
      const shellProcess = spawnShell();

      onTestFinished(() => {
        shellProcess.kill('SIGKILL');
      });

      const generic = await genericOwned(shellProcess.pid as number);
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);

      const client = vi.fn<Client>(async (argumentsList): Promise<string> => {
        const sent = client.mock.calls.filter(([call]) => call[1] === 'send-keys').length;

        if (argumentsList[1] === 'get') {
          return JSON.stringify({
            result: {
              agent: {
                pane_id: generic.paneId,
                agent: generic.agentKind,
                agent_session: {
                  kind: generic.nativeReference.kind,
                  value:
                    sent && changed === 'session' ? 'replacement' : generic.nativeReference.value,
                },
              },
            },
          });
        }

        if (argumentsList[1] === 'send-keys') {
          if (sent > 1) {
            throw new Error('Interrupted a replacement worker.');
          }

          return '{}';
        }

        if (sent) {
          clock.mockReturnValue(600);
        }

        return genericSnapshot(generic, sent && changed === 'foreground' ? 102 : generic.processId);
      });

      const result = timeout.cancelOwnedWorker(
        generic,
        1200,
        withInventory(client),
        new AbortController().signal,
      );

      await expect(result).resolves.toMatchObject({ cleanup: 'unconfirmed' });
      expect(client.mock.calls.filter(([call]) => call[1] === 'send-keys')).toHaveLength(1);
    },
  );

  it('confirms a generic stop when the agent session ends before the process does', async () => {
    const shellProcess = spawnShell();

    onTestFinished(() => {
      shellProcess.kill('SIGKILL');
    });

    const generic = await genericOwned(shellProcess.pid as number);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let polls = 0;

    const client = vi.fn<Client>(async (argumentsList): Promise<string> => {
      const sent = client.mock.calls.filter(([call]) => call[1] === 'send-keys').length;

      if (argumentsList[1] === 'get') {
        return sent
          ? '{}'
          : JSON.stringify({
              result: {
                agent: {
                  pane_id: generic.paneId,
                  agent: generic.agentKind,
                  agent_session: {
                    kind: generic.nativeReference.kind,
                    value: generic.nativeReference.value,
                  },
                },
              },
            });
      }

      if (argumentsList[1] === 'send-keys') {
        return '{}';
      }

      if (!sent) {
        return genericSnapshot(generic);
      }

      polls += 1;
      clock.mockReturnValue(600);

      return polls > 1 ? shellSnapshot(generic) : genericSnapshot(generic);
    });

    const result = await timeout.cancelOwnedWorker(
      generic,
      1200,
      withInventory(client),
      new AbortController().signal,
    );

    expect(result.cleanup).toBe('confirmed');
    expect(client.mock.calls.filter(([call]) => call[1] === 'send-keys')).toHaveLength(1);
  });

  it('never counts EPERM as an absent worker', async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    });

    const client = vi
      .fn<Client>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce('{}')
      .mockResolvedValue(shell());

    const result = await timeout.cancelOwnedWorker(
      owned,
      200,
      withInventory(client),
      new AbortController().signal,
    );

    expect(result).toMatchObject({ cleanup: 'unconfirmed' });
    expect(result.detail).toContain('Permission denied');
    expect(result.detail).toContain('manual cleanup');
  });

  it.each([snapshot(102), snapshot(101, '/tmp/replacement'), '{}'])(
    'refuses a mismatched or missing worker identity: %s',
    async (response) => {
      const client = vi.fn<Client>().mockResolvedValue(response);

      const result = await timeout.cancelOwnedWorker(
        owned,
        200,
        withInventory(client),
        new AbortController().signal,
      );

      expect(result.cleanup).toBe('refused');

      expect(client.mock.calls.map(([call]) => call.slice(0, 2))).toEqual([
        ['pane', 'process-info'],
        ['pane', 'process-info'],
      ]);
    },
  );

  it('reports failed cleanup with a manual cleanup target', async () => {
    const client = vi.fn<Client>().mockRejectedValue(new Error('injected unavailable client'));

    const result = await timeout.cancelOwnedWorker(
      owned,
      200,
      withInventory(client),
      new AbortController().signal,
    );

    expect(result.cleanup).toBe('unconfirmed');
    expect(result.detail).toContain('manual cleanup');
    expect(result.detail).toContain(owned.paneId);
    expect(result.detail).toContain('injected unavailable client');
  });

  it('does not count input delivery as stopped work', async () => {
    vi.useFakeTimers();
    const client = vi.fn<Client>().mockResolvedValue(snapshot());

    const result = timeout.cancelOwnedWorker(
      owned,
      200,
      withInventory(client),
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toMatchObject({ cleanup: 'unconfirmed' });

    expect(
      client.mock.calls.filter(([argumentsList]) => argumentsList[1] === 'send-keys'),
    ).toHaveLength(1);
  });

  it('does not call a surviving background process stopped when the shell returns', async () => {
    vi.useFakeTimers();
    vi.mocked(process.kill).mockReturnValue(true);

    const client = vi
      .fn<Client>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce('{}')
      .mockResolvedValue(shell());

    const result = timeout.cancelOwnedWorker(
      owned,
      200,
      withInventory(client),
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toMatchObject({ cleanup: 'unconfirmed' });
    expect(process.kill).toHaveBeenCalledWith(owned.processId, 0);
  });

  it.each([0, -1, Number.NaN, 2_147_483_648])(
    'rejects invalid cancellation budget %s',
    async (budget) => {
      const client = vi.fn<Client>();

      await expect(
        timeout.cancelOwnedWorker(owned, budget, client, new AbortController().signal),
      ).rejects.toThrow('integer');

      expect(client).not.toHaveBeenCalled();
    },
  );
});

describe('bounded client', () => {
  it('bounds a real stalled client and reports failure instead of success', async () => {
    const started = performance.now();

    await expect(
      timeout.runClient(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 150),
    ).rejects.toThrow('budget');

    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('reports failed client calls', async () => {
    await expect(
      timeout.runClient(process.execPath, ['-e', 'process.exit(2)'], 1000),
    ).rejects.toThrow('Command failed');
  });
});
