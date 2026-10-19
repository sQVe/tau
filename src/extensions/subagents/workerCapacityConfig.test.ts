import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { readWorkerCapacity } from './workerCapacityConfig.js';

const configFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-capacity-'));
  const agentDirectory = join(directory, 'agent');

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(agentDirectory);
  mkdirSync(join(directory, '.pi'));

  return {
    location: { cwd: directory, agentDirectory, projectTrusted: true },
    writeUser: (value: unknown) => {
      writeFileSync(join(agentDirectory, 'tau.json'), JSON.stringify(value));
    },
    writeRepository: (value: unknown) => {
      writeFileSync(join(directory, '.pi', 'tau.json'), JSON.stringify(value));
    },
  };
};

const ui = { notify: () => undefined };

it.each([
  { condition: 'the user file is missing', user: undefined },
  { condition: 'subagents is not set', user: { tracker: {} } },
  { condition: 'subagents has no capacity', user: { subagents: {} } },
])('defaults to 12 workers when $condition', ({ user }) => {
  const { location, writeUser } = configFixture();

  if (user !== undefined) {
    writeUser(user);
  }

  expect(readWorkerCapacity(location, ui)).toBe(12);
});

it.each([1, 3, 256])('reads capacity %i from the user file', (capacity) => {
  const { location, writeUser } = configFixture();

  writeUser({ subagents: { capacity } });

  expect(readWorkerCapacity(location, ui)).toBe(capacity);
});

it.each([0, 257, 300, 2.5, -1, '3', null])('refuses capacity %j', (capacity) => {
  const { location, writeUser } = configFixture();

  writeUser({ subagents: { capacity } });

  expect(() => readWorkerCapacity(location, ui)).toThrow(
    /Invalid Tau config .*tau\.json: subagents\.capacity must be an integer from 1 to 256\./,
  );
});

it('refuses a subagents value that is not an object', () => {
  const { location, writeUser } = configFixture();

  writeUser({ subagents: 4 });

  expect(() => readWorkerCapacity(location, ui)).toThrow(
    /Invalid Tau config .*tau\.json: subagents must be an object/,
  );
});

it('refuses a subagents key in the repository file', () => {
  const { location, writeUser, writeRepository } = configFixture();

  writeUser({ subagents: { capacity: 2 } });
  writeRepository({ subagents: { capacity: 200 } });

  expect(() => readWorkerCapacity(location, ui)).toThrow(
    /subagents may be set only in the user file/,
  );
});

it('warns about unknown keys inside subagents', () => {
  const { location, writeUser } = configFixture();
  const notify = vi.fn<() => void>();

  writeUser({ subagents: { capacity: 2, limit: 5 } });

  expect(readWorkerCapacity(location, { notify })).toBe(2);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('subagents.limit'), 'warning');
});
