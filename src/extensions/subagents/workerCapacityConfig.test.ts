import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryTauConfig } from '../../../tests/tauConfigHarness.js';
import { readWorkerCapacity } from './workerCapacityConfig.js';

const ui = { notify: () => undefined };

it.each([
  { condition: 'the user file is missing', user: undefined },
  { condition: 'subagents is not set', user: { tracker: {} } },
  { condition: 'subagents has no capacity', user: { subagents: {} } },
])('defaults to 12 workers when $condition', ({ user }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-worker-capacity-');

  if (user !== undefined) {
    writeUser(user);
  }

  expect(readWorkerCapacity(location, ui)).toBe(12);
});

it.each([1, 3, 256])('reads capacity %i from the user file', (capacity) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-worker-capacity-');

  writeUser({ subagents: { capacity } });

  expect(readWorkerCapacity(location, ui)).toBe(capacity);
});

it.each([0, 257, 300, 2.5, -1, '3', null])('refuses capacity %j', (capacity) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-worker-capacity-');

  writeUser({ subagents: { capacity } });

  expect(() => readWorkerCapacity(location, ui)).toThrow(
    /Invalid Tau config .*tau\.json: subagents\.capacity must be an integer from 1 to 256\./,
  );
});

it('refuses a subagents value that is not an object', () => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-worker-capacity-');

  writeUser({ subagents: 4 });

  expect(() => readWorkerCapacity(location, ui)).toThrow(
    /Invalid Tau config .*tau\.json: subagents must be an object/,
  );
});

it('refuses a subagents key in the repository file', () => {
  const { location, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-worker-capacity-',
  );

  writeUser({ subagents: { capacity: 2 } });
  writeRepository({ subagents: { capacity: 200 } });

  expect(() => readWorkerCapacity(location, ui)).toThrow(
    /subagents may be set only in the user file/,
  );
});

it('warns about unknown keys inside subagents', () => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-worker-capacity-');
  const notify = vi.fn<() => void>();

  writeUser({ subagents: { capacity: 2, limit: 5 } });

  expect(readWorkerCapacity(location, { notify })).toBe(2);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('subagents.limit'), 'warning');
});
