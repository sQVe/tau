import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it, vi } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import {
  createTemporaryRepository,
  executeCommit,
  writeRepositoryFile,
} from './fixtures/commitTool.js';

it('keeps commit objects in the working repository when GIT_OBJECT_DIRECTORY is inherited', async ({
  onTestFinished,
}) => {
  const repositoryA = await createTemporaryRepository();
  const repositoryB = await createTemporaryRepository();
  const foreignObjects = join(repositoryB, '.git', 'objects');
  const objectsBefore = await readdir(foreignObjects, { recursive: true });

  await writeRepositoryFile(repositoryA, 'file.txt', 'content\n');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('GIT_OBJECT_DIRECTORY', foreignObjects);

  await executeCommit(repositoryA, {
    groups: [{ files: ['file.txt'], subject: 'feat: add file' }],
  });

  vi.stubEnv('GIT_OBJECT_DIRECTORY', undefined);

  const objectsAfter = await readdir(foreignObjects, { recursive: true });

  const sortedObjectsBefore = objectsBefore.toSorted();
  const sortedObjectsAfter = objectsAfter.toSorted();

  expect.soft(sortedObjectsAfter).toEqual(sortedObjectsBefore);

  expect(
    (await promisify(execFile)('git', ['show', 'HEAD:file.txt'], { cwd: repositoryA })).stdout,
  ).toBe('content\n');
});

it('keeps committed content local when alternate object directories are inherited', async ({
  onTestFinished,
}) => {
  const repositoryA = await createTemporaryRepository();
  const repositoryB = await createTemporaryRepository();
  const content = 'foreign-only blob content\n';
  const foreignObjects = join(repositoryB, '.git', 'objects');

  await writeRepositoryFile(repositoryB, 'seed.txt', content);
  await git(repositoryB, 'hash-object', '-w', 'seed.txt');
  await writeRepositoryFile(repositoryA, 'file.txt', content);

  const entriesBefore = await readdir(foreignObjects, { recursive: true, withFileTypes: true });
  const foreignFiles = entriesBefore.filter((entry) => entry.isFile());
  const foreignPaths = foreignFiles.map((entry) => join(entry.parentPath, entry.name));
  const bytesBefore = await Promise.all(foreignPaths.map((path) => readFile(path)));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', foreignObjects);

  await executeCommit(repositoryA, {
    groups: [{ files: ['file.txt'], subject: 'feat: add file' }],
  });

  vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', undefined);

  expect(
    (await promisify(execFile)('git', ['show', 'HEAD:file.txt'], { cwd: repositoryA })).stdout,
  ).toBe(content);

  await git(repositoryA, 'fsck', '--full');

  const entriesAfter = await readdir(foreignObjects, { recursive: true, withFileTypes: true });
  const bytesAfter = await Promise.all(foreignPaths.map((path) => readFile(path)));

  expect(entriesAfter).toEqual(entriesBefore);
  expect(bytesAfter).toEqual(bytesBefore);
});

const inheritedNames = ['GIT_DIR', 'GIT_INDEX_FILE'] as const;
const savedValues = new Map<string, string | undefined>();

afterEach(() => {
  for (const name of inheritedNames) {
    const value = savedValues.get(name);

    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }

  savedValues.clear();
});

it('commits in the working directory when the process has another repository in its Git environment', async () => {
  const repositoryA = await createTemporaryRepository();
  const repositoryB = await createTemporaryRepository();

  await writeRepositoryFile(repositoryA, 'file.txt', 'content\n');

  const logBefore = await git(repositoryB, 'for-each-ref', '--format=%(objectname) %(refname)');
  const indexBefore = await git(repositoryB, 'ls-files', '--stage');

  for (const name of inheritedNames) {
    savedValues.set(name, process.env[name]);
  }

  process.env.GIT_DIR = join(repositoryB, '.git');
  process.env.GIT_INDEX_FILE = join(repositoryB, '.git', 'index');

  await executeCommit(repositoryA, {
    groups: [{ files: ['file.txt'], subject: 'feat: add file' }],
  });

  for (const name of inheritedNames) {
    Reflect.deleteProperty(process.env, name);
  }

  expect(
    (await promisify(execFile)('git', ['log', '--format=%s'], { cwd: repositoryA })).stdout,
  ).toBe('feat: add file\n');

  expect(await git(repositoryB, 'for-each-ref', '--format=%(objectname) %(refname)')).toBe(
    logBefore,
  );

  expect(await git(repositoryB, 'ls-files', '--stage')).toBe(indexBefore);
});
