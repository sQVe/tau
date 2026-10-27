import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.ts';
import { createScratchRepository, git, piChildEnvironment } from './piSmokeSetup.ts';

const repositorySnapshot = (repository: string) => ({
  log: git(repository, ['log', '--format=%H %s']),
  index: readFileSync(join(repository, '.git', 'index')),
  config: readFileSync(join(repository, '.git', 'config'), 'utf8'),
});

it('keeps a repository selected by GIT_DIR and GIT_INDEX_FILE unchanged', async ({
  onTestFinished,
}) => {
  const otherRepository = await createTemporaryRepository(onTestFinished);
  const otherGitDirectory = join(otherRepository, '.git');

  writeFileSync(join(otherRepository, 'other.txt'), 'other\n');
  git(otherRepository, ['add', 'other.txt']);
  git(otherRepository, ['commit', '--quiet', '--message', 'chore: other']);

  const before = repositorySnapshot(otherRepository);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('GIT_DIR', otherGitDirectory);
  vi.stubEnv('GIT_INDEX_FILE', join(otherGitDirectory, 'index'));

  const scratchRepository = createScratchRepository(otherRepository);

  onTestFinished(() => {
    rmSync(scratchRepository, { recursive: true, force: true });
  });

  expect(repositorySnapshot(otherRepository)).toEqual(before);
});

it('gives the Pi child no Git repository selectors and keeps the adjusted PATH', ({
  onTestFinished,
}) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('GIT_DIR', '/caller/.git');
  vi.stubEnv('GIT_WORK_TREE', '/caller');
  vi.stubEnv('GIT_COMMON_DIR', '/caller/.git');
  vi.stubEnv('GIT_INDEX_FILE', '/caller/.git/index');
  vi.stubEnv('TAU_SMOKE_CREDENTIAL', 'kept');

  const environment = piChildEnvironment('/caller/node_modules/.bin:/usr/bin');

  expect(environment).toMatchObject({
    PATH: '/usr/bin',
    TAU_SMOKE_CREDENTIAL: 'kept',
  });

  expect(environment).not.toHaveProperty('GIT_DIR');
  expect(environment).not.toHaveProperty('GIT_WORK_TREE');
  expect(environment).not.toHaveProperty('GIT_COMMON_DIR');
  expect(environment).not.toHaveProperty('GIT_INDEX_FILE');
});
