import { afterEach, expect, it, vi } from 'vitest';

import type { Exec } from '../../../command.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { launchLookup, lookupLaunchTerminal } from './launchLookup.js';

interface Call {
  commandArguments: readonly string[];
  timeout: number | undefined;
}

const runtimeOf = (exec: Exec, calls: Call[] = []): { runtime: HcRuntime; calls: Call[] } => ({
  runtime: { exec, connect: () => Promise.reject(new Error('unused')), cwd: '/repository' },
  calls,
});

const listOf = (addresses: string[]): string =>
  JSON.stringify({
    terminals: addresses.map((address) => ({ address, state: 'live' })),
  });

afterEach(() => {
  vi.useRealTimers();
});

it('ends as unread within the lookup window when hc ls never answers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const calls: Call[] = [];

  const exec: Exec = (_command, commandArguments, options) => {
    calls.push({ commandArguments, timeout: options?.timeout });

    return new Promise((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('hc ls timed out'));
      }, options?.timeout ?? 1);
    });
  };

  const { runtime } = runtimeOf(exec);
  const lookup = launchLookup({ kind: 'open', identifier: 'claim', hc: runtime });

  await vi.advanceTimersByTimeAsync(10_000);

  await expect(lookup).resolves.toEqual({ kind: 'unread' });
  expect(calls[0]?.timeout).toBe(10_000);
});

it('finds a matching terminal even when a sibling read rejects', async () => {
  const exec: Exec = (_command, commandArguments) => {
    const address = commandArguments.at(-1) ?? '';

    if (commandArguments[0] === 'ls') {
      return Promise.resolve({
        code: 0,
        killed: false,
        truncated: false,
        stdout: listOf(['t-one', 't-two']),
        stderr: '',
      });
    }

    if (address === 't-one') {
      return Promise.reject(new Error('no such terminal: t-one'));
    }

    return Promise.resolve({
      code: 0,
      killed: false,
      truncated: false,
      stdout: JSON.stringify({
        address: 't-two',
        state: 'live',
        argv: ['env', 'TAU_ARCHITECT_CLAIM=claim', 'pi'],
      }),
      stderr: '',
    });
  };

  const { runtime } = runtimeOf(exec);

  await expect(launchLookup({ kind: 'open', identifier: 'claim', hc: runtime })).resolves.toEqual({
    kind: 'found',
    terminal: 't-two',
    state: 'live',
  });
});

it('reads a terminal without argv as unread', async () => {
  const exec: Exec = (_command, commandArguments) => {
    if (commandArguments[0] === 'ls') {
      return Promise.resolve({
        code: 0,
        killed: false,
        truncated: false,
        stdout: listOf(['t-one']),
        stderr: '',
      });
    }

    return Promise.resolve({
      code: 0,
      killed: false,
      truncated: false,
      stdout: JSON.stringify({ address: 't-one', state: 'live' }),
      stderr: '',
    });
  };

  const { runtime } = runtimeOf(exec);

  await expect(
    lookupLaunchTerminal({ kind: 'open', identifier: 'claim', hc: runtime }),
  ).resolves.toEqual({ kind: 'unread' });
});

it('reads a complete list with no match as absent', async () => {
  const calls: Call[] = [];

  const exec: Exec = (_command, commandArguments, options) => {
    calls.push({ commandArguments, timeout: options?.timeout });

    if (commandArguments[0] === 'ls') {
      return Promise.resolve({
        code: 0,
        killed: false,
        truncated: false,
        stdout: listOf(['t-one']),
        stderr: '',
      });
    }

    return Promise.resolve({
      code: 0,
      killed: false,
      truncated: false,
      stdout: JSON.stringify({
        address: 't-one',
        state: 'live',
        argv: ['env', 'TAU_ARCHITECT_CLAIM=other', 'pi'],
      }),
      stderr: '',
    });
  };

  const { runtime } = runtimeOf(exec, calls);

  await expect(
    lookupLaunchTerminal({ kind: 'open', identifier: 'claim', hc: runtime }),
  ).resolves.toEqual({ kind: 'absent' });

  expect(calls[0]?.timeout).toBe(10_000);
  expect(calls[1]?.timeout).toBeGreaterThan(0);
  expect(calls[1]?.timeout).toBeLessThanOrEqual(10_000);
});

it('never reads an empty terminal address', async () => {
  const read: string[] = [];

  const exec: Exec = (_command, commandArguments) => {
    if (commandArguments[0] === 'ls') {
      return Promise.resolve({
        code: 0,
        killed: false,
        truncated: false,
        stdout: listOf(['', 't-one']),
        stderr: '',
      });
    }

    read.push(commandArguments.at(-1) ?? '');

    return Promise.resolve({
      code: 0,
      killed: false,
      truncated: false,
      stdout: JSON.stringify({ address: 't-one', state: 'live', argv: [] }),
      stderr: '',
    });
  };

  const { runtime } = runtimeOf(exec);

  await lookupLaunchTerminal({ kind: 'open', identifier: 'claim', hc: runtime });

  expect(read).toEqual(['t-one']);
});
