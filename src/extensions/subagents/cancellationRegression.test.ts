import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as timeout from './cancellation.js';
import { paneListResponse, processInfoResponse } from './fixtures/herdrFake.js';

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

  it('sends no keys to a Pi worker, which stops only when its pane closes', async () => {
    const client = vi.fn<Client>();

    await expect(
      timeout.cancelOwnedWorker(
        { ...owned, kind: 'pi', shellPid: owned.processId },
        200,
        withInventory(client),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Cancellation requires');

    expect(client).not.toHaveBeenCalled();
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
