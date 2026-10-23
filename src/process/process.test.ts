import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, expect, it, vi } from 'vitest';

import { groupState, processState, signalGroup, stopGroup } from './process.js';

vi.mock(import('node:child_process'), async (importOriginal) => {
  const original = await importOriginal();
  const { promisify: asPromise } = await import('node:util');
  const executePromise = asPromise(original.execFile);

  const execute = Object.assign(
    (...argumentsList: Parameters<typeof original.execFile>) => original.execFile(...argumentsList),
    {
      [asPromise.custom]: vi.fn<typeof executePromise>(executePromise),
    },
  );

  return { ...original, execFile: execute as unknown as typeof original.execFile };
});

vi.mock(import('node:timers/promises'), async (importOriginal) => ({
  ...(await importOriginal()),
  setTimeout: (await import('../../tests/timerFake.js')).globalTimerDelay,
}));

const runningAsRoot = process.getuid?.() === 0;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
});

const failProbeWith = (code: string): void => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(code), { code });
  });
};

it('counts the current process as running', () => {
  expect(processState(process.pid)).toBe('running');
});

it('counts an exited child as gone', () => {
  const child = spawnSync(process.execPath, ['-e', '']);

  expect(child.pid).toBeGreaterThan(0);
  expect(processState(child.pid)).toBe('gone');
});

it.skipIf(runningAsRoot)('counts a process it may not signal as running', () => {
  expect(processState(1)).toBe('running');
});

it('probes with signal 0 and reports ESRCH as gone', () => {
  const signals: unknown[] = [];

  vi.spyOn(process, 'kill').mockImplementation((processId, signal) => {
    signals.push([processId, signal]);

    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  });

  expect(processState(101)).toBe('gone');
  expect(signals).toEqual([[101, 0]]);
});

it('reports EPERM as running', () => {
  failProbeWith('EPERM');

  expect(processState(101)).toBe('running');
});

it('reports any other probe error as unknown', () => {
  failProbeWith('EINVAL');

  expect(processState(101)).toBe('unknown');
});

it('reports a non-Error probe failure as unknown', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    // oxlint-disable-next-line typescript/only-throw-error -- Exercise an untyped OS-boundary failure.
    throw 'ESRCH';
  });

  expect(processState(101)).toBe('unknown');
});

it.each([
  { code: 'ESRCH', expected: 'gone' },
  { code: 'EINVAL', expected: 'unknown' },
])(
  'returns $expected without reading the process table after $code',
  async ({ code, expected }) => {
    failProbeWith(code);
    const read = vi.mocked(promisify(execFile));

    expect(await groupState(101)).toBe(expected);
    expect(read).not.toHaveBeenCalled();
  },
);

it('keeps a permission-denied group running without reading an omitted process-table row', async () => {
  failProbeWith('EPERM');
  const read = vi.mocked(promisify(execFile)).mockResolvedValue({ stdout: '202 S\n', stderr: '' });

  expect(await groupState(101)).toBe('running');
  expect(read).not.toHaveBeenCalled();
});

it('reports a failed process-table read as unknown', async () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const read = vi.mocked(promisify(execFile)).mockRejectedValue(new Error('ps failed'));

  expect(await groupState(101)).toBe('unknown');
  expect(read).toHaveBeenCalledWith('ps', ['-A', '-o', 'pgid=,stat=']);
});

it('signals only the direct child when no process id is available', () => {
  const groupSignal = vi.spyOn(process, 'kill');
  const kill = vi.fn<() => boolean>();

  signalGroup({ kill } as never, 'SIGTERM');

  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(groupSignal).not.toHaveBeenCalled();
});

it('does not signal the direct child after a successful group signal', () => {
  const groupSignal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const kill = vi.fn<() => boolean>();

  signalGroup({ pid: 4242, kill } as never, 'SIGTERM');

  expect(groupSignal).toHaveBeenCalledExactlyOnceWith(-4242, 'SIGTERM');
  expect(kill).not.toHaveBeenCalled();
});

it('does not throw when both group and child signaling fail', () => {
  failProbeWith('ESRCH');

  const kill = vi.fn<() => boolean>(() => {
    throw new Error('Child exited');
  });

  expect(() => {
    signalGroup({ pid: 4242, kill } as never, 'SIGKILL');
  }).not.toThrow();

  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
});

it('falls back to the child when the group signal throws', () => {
  failProbeWith('ESRCH');

  const killed: unknown[] = [];
  const child = { pid: 4242, kill: (signal: unknown) => killed.push(signal) };

  signalGroup(child as never, 'SIGKILL');

  expect(killed).toEqual(['SIGKILL']);
});

it('kills a child that ignores SIGTERM and resolves when its group is gone', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );

  await new Promise((resolve) => {
    child.stdout.once('data', resolve);
  });

  await stopGroup(child, 100);

  expect(child.pid).toBeGreaterThan(0);
  expect(processState(child.pid ?? 0)).not.toBe('running');
});

const stoppingFixture = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const signals: unknown[] = [];
  let errorCode: string | undefined;

  vi.spyOn(process, 'kill').mockImplementation((_processId, signal) => {
    if (signal !== 0) {
      signals.push(signal);
    } else if (errorCode !== undefined) {
      throw Object.assign(new Error(errorCode), { code: errorCode });
    }

    return true;
  });

  let settled = false;

  const outcome = stopGroup({ pid: 4242 } as never, 100).then(() => {
    settled = true;

    return undefined;
  });

  return {
    signals,
    outcome,
    settled: () => settled,
    markGone: () => {
      errorCode = 'ESRCH';
    },
  };
};

it('waits through unknown until SIGKILL and then resolves for unknown', async () => {
  vi.mocked(promisify(execFile)).mockRejectedValue(new Error('ps failed'));
  const stopping = stoppingFixture();

  await vi.advanceTimersByTimeAsync(99);

  expect(stopping.settled()).toBe(false);
  expect(stopping.signals).toEqual(['SIGTERM']);

  await vi.advanceTimersByTimeAsync(1);

  expect(stopping.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(stopping.settled()).toBe(false);

  await vi.advanceTimersByTimeAsync(20);
  await stopping.outcome;
  await vi.advanceTimersByTimeAsync(200);

  expect(stopping.settled()).toBe(true);
  expect(stopping.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(vi.getTimerCount()).toBe(0);
});

it('escalates once while the group remains alive and stops polling when it is gone', async () => {
  vi.mocked(promisify(execFile)).mockResolvedValue({ stdout: '4242 S\n', stderr: '' });
  const stopping = stoppingFixture();

  await vi.advanceTimersByTimeAsync(300);

  expect(stopping.settled()).toBe(false);
  expect(stopping.signals).toEqual(['SIGTERM', 'SIGKILL']);

  stopping.markGone();
  await vi.advanceTimersByTimeAsync(20);
  await stopping.outcome;
  await vi.advanceTimersByTimeAsync(200);

  expect(stopping.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(vi.getTimerCount()).toBe(0);
});

it('resolves at once for a child with no process id', async () => {
  await expect(stopGroup({} as never, 100)).resolves.toBeUndefined();
});
