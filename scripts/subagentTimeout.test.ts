import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as timeout from './subagentTimeout.ts';

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

describe('parent-scoped timeout', () => {
  beforeEach(() => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Process absent'), { code: 'ESRCH' });
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps one deadline and cancellation attempt across activity and reconnect', async () => {
    vi.useFakeTimers();
    const client = vi
      .fn<Client>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce('{}')
      .mockResolvedValue(shell());
    const parent = new AbortController();
    const task = timeout.createParentDeadline(owned, 1000, 200, client, parent.signal);
    const first = task.watch();

    await vi.advanceTimersByTimeAsync(700);
    const reconnected = task.watch();

    expect(reconnected).toBe(first);
    expect(client).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);

    await expect(first).resolves.toMatchObject({
      reason: 'timeout',
      output: 'incomplete',
      cleanup: 'confirmed',
    });
    expect(client.mock.calls.filter(([arguments_]) => arguments_[1] === 'send-keys')).toHaveLength(
      1,
    );
    expect(task.watch()).toBe(first);
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
      ['agent', 'send-keys', owned.paneId, 'ctrl+c', 'ctrl+d'],
      expect.any(Number),
      expect.any(AbortSignal),
    );
  });

  it('ends observation on parent shutdown without promising cleanup', async () => {
    vi.useFakeTimers();
    const client = vi.fn<Client>();
    const parent = new AbortController();
    const task = timeout.createParentDeadline(owned, 1000, 200, client, parent.signal);

    parent.abort();
    await expect(task.watch()).resolves.toMatchObject({
      reason: 'parent-stopped',
      output: 'incomplete',
      cleanup: 'unconfirmed',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(client).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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

  it('refuses cancellation when the parent resumes after the fixed deadline', async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const client = vi
      .fn<Client>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce('{}')
      .mockResolvedValue(shell());
    const task = timeout.createParentDeadline(
      owned,
      1000,
      200,
      client,
      new AbortController().signal,
    );

    clock.mockReturnValue(1001);
    await vi.advanceTimersByTimeAsync(800);

    await expect(task.watch()).resolves.toMatchObject({
      reason: 'timeout',
      cleanup: 'unconfirmed',
    });
    expect(client).not.toHaveBeenCalled();
  });

  it('rejects invalid deadline budgets', () => {
    const client = vi.fn<Client>();
    const parent = new AbortController();

    expect(() => timeout.createParentDeadline(owned, 100, 100, client, parent.signal)).toThrow(
      'smaller',
    );
    expect(() =>
      timeout.createParentDeadline(owned, Number.NaN, 10, client, parent.signal),
    ).toThrow('integer');
  });
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
