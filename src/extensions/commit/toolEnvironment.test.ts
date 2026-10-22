import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import {
  createTemporaryRepository,
  executeCommit,
  git,
  writeRepositoryFile,
} from './fixtures/commitTool.js';

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
