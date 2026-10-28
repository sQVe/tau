import { execFileSync } from 'node:child_process';
import type { PathLike } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { readCompletedCapture } from './completedCapture.js';
import { captureGeneration } from './generation.js';
import {
  generationFolderName,
  generationInputFileName,
  generationPatchFileName,
  recordFileName,
} from './record.js';

const failure = vi.hoisted(() => ({ call: '', path: '' }));

const fails = (call: string, path: unknown) =>
  failure.call === call && String(path).endsWith(failure.path);

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    mkdir: (async (...parameters: Parameters<typeof actual.mkdir>) => {
      if (fails('mkdir', parameters[0])) {
        throw new Error('mkdir failed');
      }

      return actual.mkdir(...parameters);
    }) as typeof actual.mkdir,
    writeFile: async (...parameters: Parameters<typeof actual.writeFile>) => {
      if (fails('writeFile', parameters[0])) {
        throw new Error('write failed');
      }

      return actual.writeFile(...parameters);
    },
    appendFile: async (...parameters: Parameters<typeof actual.appendFile>) => {
      if (fails('appendFile', parameters[0])) {
        await actual.appendFile(parameters[0], 'cut-off');

        throw new Error('append failed');
      }

      return actual.appendFile(...parameters);
    },
    copyFile: async (...parameters: Parameters<typeof actual.copyFile>) => {
      if (fails('copyFile', parameters[0])) {
        await actual.writeFile(parameters[0], 'changed after the patch\n');
      }

      return actual.copyFile(...parameters);
    },
    readFile: (async (path: PathLike, options?: BufferEncoding) => {
      if (fails('readFile', path)) {
        return Buffer.from('changed on disk');
      }

      return actual.readFile(path, options);
    }) as typeof actual.readFile,
  };
});

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    linkSync: (existingPath: PathLike, newPath: PathLike) => {
      if (fails('linkSync', newPath)) {
        throw new Error('link failed');
      }

      if (fails('linkTaken', newPath)) {
        actual.writeFileSync(newPath, 'another writer\n');

        throw new Error('link target exists');
      }

      actual.linkSync(existingPath, newPath);
    },
    openSync: ((path: PathLike, flags: string, mode?: number) => {
      if (flags === 'r' && fails('openSync', path)) {
        throw new Error('directory fsync failed');
      }

      return actual.openSync(path, flags, mode);
    }) as typeof actual.openSync,
  };
});

const inputHeader = '# Review input\n\n## Capture\n';

const endpointRefs = (root: string) => git(root, 'for-each-ref', 'refs/tau/');

const blobHash = (root: string, bytes: Buffer) =>
  execFileSync('git', ['hash-object', '--stdin'], { cwd: root, input: bytes })
    .toString('utf8')
    .trim();

const changedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-generation-publish-');

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(directory, 'input.md'), inputHeader);

  onTestFinished(() => {
    failure.call = '';
    failure.path = '';
  });

  return { root, directory };
};

const workingTree = { kind: 'workingTree', base: 'HEAD' } as const;

it.each([
  { phase: 'claim', call: 'mkdir', path: '/capture', message: 'mkdir failed' },
  { phase: 'patch write', call: 'writeFile', path: 'capture/patch.diff', message: 'write failed' },
  { phase: 'input write', call: 'writeFile', path: 'capture/input.md', message: 'write failed' },
  { phase: 'input append', call: 'appendFile', path: 'input.md', message: 'append failed' },
  {
    phase: 'read-back mismatch',
    call: 'readFile',
    path: 'capture/patch.diff',
    message: 'does not hold the bytes',
  },
  { phase: 'record publish', call: 'linkSync', path: recordFileName, message: 'link failed' },
])(
  'leaves no record and restores input.md when the $phase fails',
  async ({ call, path, message }) => {
    const { root, directory } = await changedRepository();

    failure.call = call;
    failure.path = path;

    const capture = captureGeneration(root, directory, workingTree);

    await expect(capture).rejects.toThrow(message);
    await expect(capture).rejects.not.toThrow('rollback also failed');

    failure.call = '';

    expect(await readdir(directory)).toEqual(['input.md']);
    expect(await readFile(join(directory, 'input.md'), 'utf8')).toBe(inputHeader);
    expect(await endpointRefs(root)).toBe('');
    await expect(readCompletedCapture(root, directory)).rejects.toThrow(recordFileName);
  },
);

it('publishes no endpoint when a file changes between the patch and the snapshot', async () => {
  const { root, directory } = await changedRepository();

  failure.call = 'copyFile';
  failure.path = 'tracked.txt';

  await expect(captureGeneration(root, directory, workingTree)).rejects.toThrow(
    'does not match the capture',
  );

  failure.call = '';

  expect(await readdir(directory)).toEqual(['input.md']);
  expect(await endpointRefs(root)).toBe('');
});

it('removes the linked capture.json when the directory fsync after the link fails', async () => {
  const { root, directory } = await changedRepository();

  failure.call = 'openSync';
  failure.path = directory;

  await expect(captureGeneration(root, directory, workingTree)).rejects.toThrow(
    'directory fsync failed',
  );

  failure.call = '';

  expect(await readdir(directory)).toEqual(['input.md']);
  expect(await readFile(join(directory, 'input.md'), 'utf8')).toBe(inputHeader);
});

it('keeps a capture.json another writer published when the link fails', async () => {
  const { root, directory } = await changedRepository();

  failure.call = 'linkTaken';
  failure.path = recordFileName;

  await expect(captureGeneration(root, directory, workingTree)).rejects.toThrow(
    'link target exists',
  );

  failure.call = '';

  expect((await readdir(directory)).toSorted()).toEqual([recordFileName, 'input.md']);
  expect(await readFile(join(directory, recordFileName), 'utf8')).toBe('another writer\n');
  expect(await readFile(join(directory, 'input.md'), 'utf8')).toBe(inputHeader);
});

it('refuses a second capture over a capture folder an earlier capture left without a record', async () => {
  const { root, directory } = await changedRepository();

  await mkdir(join(directory, generationFolderName));

  await expect(captureGeneration(root, directory, workingTree)).rejects.toThrow(
    'an earlier capture failed partway',
  );

  expect((await readdir(directory)).toSorted()).toEqual([generationFolderName, 'input.md']);
  expect(await readFile(join(directory, 'input.md'), 'utf8')).toBe(inputHeader);
  expect((await readCompletedCapture(root, directory)).status).toBe('incomplete');
});

it('lets one of two captures started at once publish a record of its own artifacts', async () => {
  const { root, directory } = await changedRepository();

  const results = await Promise.allSettled([
    captureGeneration(root, directory, workingTree),
    captureGeneration(root, directory, workingTree),
  ]);

  const published = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );

  const folder = join(directory, generationFolderName);
  const patch = await readFile(join(folder, generationPatchFileName));
  const input = await readFile(join(folder, generationInputFileName));
  const recordBytes = await readFile(join(directory, recordFileName));
  const record = JSON.parse(recordBytes.toString('utf8')) as unknown;
  const identity = blobHash(root, recordBytes);

  expect(published).toEqual([expect.objectContaining({ identity })]);

  expect(record).toMatchObject({
    version: 5,
    original: { patch: blobHash(root, patch), input: blobHash(root, input) },
  });

  expect(await readFile(join(directory, 'input.md'))).toEqual(input);

  expect(await readCompletedCapture(root, directory)).toEqual({
    status: 'completed',
    identity,
    reasons: [],
    endpoint: 'complete',
  });
});
