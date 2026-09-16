import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as timeout from './cancellation.js';

type Client = Parameters<typeof timeout.cancelOwnedWorker>[2];

const owned = {
  kind: 'process' as const,
  paneId: 'w1:p2',
  shellPid: 100,
  processId: 101,
  token: '/tmp/owned-session.jsonl',
};
const snapshot = (processId = owned.processId, token = owned.token) =>
  JSON.stringify({
    result: {
      process_info: {
        pane_id: owned.paneId,
        shell_pid: owned.shellPid,
        foreground_process_group_id: processId,
        foreground_processes: [{ pid: processId, argv: ['pi', '--session', token] }],
      },
    },
  });

const shell = () => snapshot(owned.shellPid);

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
    const recognized = JSON.stringify({
      result: {
        agent: { pane_id: owned.paneId, agent: 'pi', agent_session: { value: owned.token } },
      },
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
      client,
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
    const client = vi.fn<Client>(async (arguments_) => {
      if (arguments_[1] === 'get') {
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
      if (arguments_[1] === 'send-keys') {
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
      client,
      new AbortController().signal,
    );
    const sent = client.mock.calls.filter(([arguments_]) => arguments_[1] === 'send-keys');

    expect(result.cleanup).toBe(scenario === 'rewritten argv' ? 'confirmed' : 'refused');
    expect(sent).toHaveLength(scenario === 'rewritten argv' ? 1 : 0);
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
      client,
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
        client,
        new AbortController().signal,
      );

      expect(result.cleanup).toBe('refused');
      expect(client).toHaveBeenCalledTimes(1);
    },
  );

  it('reports failed cleanup with a manual cleanup target', async () => {
    const client = vi.fn<Client>().mockRejectedValue(new Error('injected unavailable client'));
    const result = await timeout.cancelOwnedWorker(
      owned,
      200,
      client,
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
    const result = timeout.cancelOwnedWorker(owned, 200, client, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toMatchObject({ cleanup: 'unconfirmed' });
    expect(client.mock.calls.filter(([arguments_]) => arguments_[1] === 'send-keys')).toHaveLength(
      1,
    );
  });

  it('does not call a surviving background process stopped when the shell returns', async () => {
    vi.useFakeTimers();
    vi.mocked(process.kill).mockReturnValue(true);
    const client = vi
      .fn<Client>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce('{}')
      .mockResolvedValue(shell());
    const result = timeout.cancelOwnedWorker(owned, 200, client, new AbortController().signal);

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
