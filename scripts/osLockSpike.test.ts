import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

import {
  osLockHolderArgv,
  osLockMarkerWriteExitCode,
  osLockParentFixturePathFrom,
  osLockWrapperArgv,
} from './osLockSpike.js';

it('wraps a command so the command itself holds the lock', () => {
  expect(
    osLockWrapperArgv('/checkout/.tau/architect/lock', ['env', 'TAU_ROLE=architect', 'pi']),
  ).toEqual([
    'flock',
    '-F',
    '-n',
    '-E',
    '75',
    '/checkout/.tau/architect/lock',
    'env',
    'TAU_ROLE=architect',
    'pi',
  ]);
});

it('resolves the parent fixture path with its spaces decoded', () => {
  const checkout = '/checkout with space';
  const moduleUrl = pathToFileURL(join(checkout, 'scripts', 'osLockSpike.ts'));

  expect(osLockParentFixturePathFrom(moduleUrl)).toBe(
    join(checkout, 'tests', 'osLockParentHarness.ts'),
  );
});

it('wraps a holder so it signals readiness after the lock is taken', () => {
  expect(osLockHolderArgv('/checkout/.tau/architect/lock.ready', ['sleep', '60'])).toEqual([
    'sh',
    '-c',
    `printf ready > "$1" || exit ${String(osLockMarkerWriteExitCode)}; shift; exec "$@"`,
    'tau-os-lock-holder',
    '/checkout/.tau/architect/lock.ready',
    'sleep',
    '60',
  ]);
});
