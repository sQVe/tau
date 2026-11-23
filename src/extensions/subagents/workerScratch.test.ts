import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import {
  createScratchDirectory,
  errorAfterScratchCleanup,
  removeScratchDirectory,
  scratchDirectoryFor,
  scratchRootFor,
} from './workerScratch.js';

const assignmentId = '3f9a2c1d-0000-4000-8000-000000000000';

// Chrome appends this suffix to TMPDIR for its singleton socket.
const chromeSingletonSocketSuffix = '/com.google.Chrome.XXXXXX/SingletonSocket';
// macOS limits a Unix socket path to 103 bytes, the stricter bound Tau uses.
const unixSocketPathLimit = 103;

const socketPathFor = (agentDirectory: string): string =>
  `${scratchDirectoryFor(agentDirectory, assignmentId)}${chromeSingletonSocketSuffix}`;

it.each([
  { agentDirectory: '/home/sqve/.pi/agent', byteLength: 20 },
  { agentDirectory: '/home/sqve/.pi/agent'.padEnd(46, 'x'), byteLength: 46 },
])(
  'keeps the Chrome socket path within the Unix limit for a $byteLength-byte agent directory',
  ({ agentDirectory, byteLength }) => {
    expect(Buffer.byteLength(agentDirectory)).toBe(byteLength);

    expect(Buffer.byteLength(socketPathFor(agentDirectory))).toBeLessThanOrEqual(
      unixSocketPathLimit,
    );
  },
);

it('names the scratch folder with the assignment short id', () => {
  expect(scratchDirectoryFor('/agent', assignmentId)).toBe('/agent/tmp/ws/3f9a2c1d');
});

it.each(['', '.', '..', 'a/b'])(
  'refuses to remove a scratch name that escapes the root: %s',
  async (name) => {
    const agentDirectory = temporaryDirectory(onTestFinished, 'tau-scratch-name-');
    const root = scratchRootFor(agentDirectory);
    const marker = join(root, 'a', 'b', 'keep.txt');

    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(marker, 'keep');

    const error = await removeScratchDirectory(agentDirectory, name);

    expect(error).toContain(`Invalid temporary folder name ${JSON.stringify(name)}`);

    expect(error).toContain('Cleanup refused');
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(join(agentDirectory, 'tmp'))).toBe(true);
  },
);

it('refuses to remove when the scratch root is a symlink', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-scratch-root-');
  const elsewhere = temporaryDirectory(onTestFinished, 'tau-scratch-target-');
  const marker = join(elsewhere, 'one', 'keep.txt');

  mkdirSync(join(elsewhere, 'one'), { recursive: true });
  writeFileSync(marker, 'keep');
  mkdirSync(join(agentDirectory, 'tmp'), { recursive: true });
  symlinkSync(elsewhere, scratchRootFor(agentDirectory));

  const error = await removeScratchDirectory(agentDirectory, 'one');

  expect(error).toContain('redirected');
  expect(existsSync(marker)).toBe(true);
});

it.each(['root', 'tmp'] as const)(
  'refuses to create a scratch folder when the %s is a symlink',
  async (redirected) => {
    const agentDirectory = temporaryDirectory(onTestFinished, 'tau-scratch-create-');
    const elsewhere = temporaryDirectory(onTestFinished, 'tau-scratch-create-target-');

    if (redirected === 'tmp') {
      symlinkSync(elsewhere, join(agentDirectory, 'tmp'));
    } else {
      mkdirSync(join(agentDirectory, 'tmp'), { recursive: true });
      symlinkSync(elsewhere, scratchRootFor(agentDirectory));
    }

    const rootName = redirected === 'tmp' ? 'tmp' : 'ws';

    await expect(
      createScratchDirectory(agentDirectory, '11111111-1111-1111-1111-111111111111'),
    ).rejects.toThrow(`Temporary root ${rootName} is redirected`);

    expect(readdirSync(elsewhere)).toEqual([]);
  },
);

it('creates a private scratch folder under a missing root', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-scratch-new-');

  await createScratchDirectory(agentDirectory, 'one');

  expect(existsSync(scratchDirectoryFor(agentDirectory, 'one'))).toBe(true);
});

it('treats a missing scratch folder as removed', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-scratch-missing-');

  expect(await removeScratchDirectory(agentDirectory, 'one')).toBeUndefined();

  mkdirSync(scratchRootFor(agentDirectory), { recursive: true });

  expect(await removeScratchDirectory(agentDirectory, 'one')).toBeUndefined();
});

it('keeps the launch error and adds the scratch cleanup error', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-scratch-error-');
  const original = new Error('launch failure');

  const clean = await errorAfterScratchCleanup(agentDirectory, 'one', original);
  const refused = await errorAfterScratchCleanup(agentDirectory, '..', original);

  expect(clean).toBe(original);
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain('launch failure');
  expect((refused as Error).message).toContain('Also failed to remove the worker scratch folder');
  expect((refused as Error).cause).toBe(original);
});
