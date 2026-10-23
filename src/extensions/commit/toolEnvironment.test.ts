import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import {
  createTemporaryRepository,
  executeCommit,
  git,
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
  expect(await git(repositoryA, ['show', 'HEAD:file.txt'])).toBe('content\n');
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

  const logBefore = await git(repositoryB, ['for-each-ref', '--format=%(objectname) %(refname)']);
  const indexBefore = await git(repositoryB, ['ls-files', '--stage']);

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

  expect(await git(repositoryA, ['log', '--format=%s'])).toBe('feat: add file\n');

  expect(await git(repositoryB, ['for-each-ref', '--format=%(objectname) %(refname)'])).toBe(
    logBefore,
  );

  expect(await git(repositoryB, ['ls-files', '--stage'])).toBe(indexBefore);
});
