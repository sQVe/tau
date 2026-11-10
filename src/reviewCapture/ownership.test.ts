import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { git } from '../../tests/gitRepository.js';
import { createGhFake, pullRequest } from '../../tests/prGhFake.js';
import type { GhFake } from '../../tests/prGhFake.js';
import {
  failGitCommand,
  preparedReview,
  savedArtifactState,
} from './fixtures/reviewDirectoryHarness.js';
import { readCaptureOwnership, readOwnership } from './ownership.js';

it.each([
  {
    name: 'failed PR list',
    prepare: (fake: GhFake) => {
      fake.failCommand('pr list');
    },
  },
  {
    name: 'malformed PR list',
    prepare: (fake: GhFake) => {
      fake.overrideOutput('pr list', '{}');
    },
  },
  {
    name: 'failed repository',
    prepare: (fake: GhFake) => {
      fake.failCommand('repo view');
    },
  },
  {
    name: 'failed viewer',
    prepare: (fake: GhFake) => {
      fake.failCommand('api user');
    },
  },
  {
    name: 'missing viewer',
    prepare: (fake: GhFake) => {
      fake.overrideOutput('api user', '{}');
    },
  },
  {
    name: 'malformed viewer',
    prepare: (fake: GhFake) => {
      fake.overrideOutput('api user', '{');
    },
  },
  {
    name: 'empty viewer',
    prepare: (fake: GhFake) => {
      fake.overrideOutput('api user', '{"login":""}');
    },
  },
])('returns unclear for $name without changing saved files', async ({ prepare }) => {
  const { root, directory } = await preparedReview();
  const fake = createGhFake();
  const head = await git(root, 'rev-parse', 'HEAD');

  await git(root, 'checkout', '-b', 'feature');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };
  fake.pullRequests['github.com/sQVe/tau'] = [pullRequest()];
  prepare(fake);

  const before = await savedArtifactState(directory);
  const result = await readCaptureOwnership({ cwd: root, exec: fake.exec }, { base: head, head });

  expect(result.status).toBe('unclear');
  expect(result.reasons.length).toBeGreaterThan(0);
  expect(await savedArtifactState(directory)).toEqual(before);
});

it.each([
  {
    name: 'detached HEAD',
    commands: [
      ['remote', 'add', 'origin', 'https://github.com/sQVe/tau.git'],
      ['checkout', '--detach'],
    ],
  },
  { name: 'local remote', commands: [['remote', 'add', 'origin', '/local/repository']] },
])('uses commit ownership with $name and makes no GitHub reads', async ({ commands }) => {
  const { root } = await preparedReview();
  const fake = createGhFake();
  const head = await git(root, 'rev-parse', 'HEAD');

  for (const commandArguments of commands) {
    await git(root, ...commandArguments);
  }

  const result = await readCaptureOwnership({ cwd: root, exec: fake.exec }, { base: null, head });

  expect(result.status).toBe('own');
  expect(fake.calls).toEqual([]);
});

it('returns unclear when a GitHub remote has an unusable push target', async () => {
  const { root } = await preparedReview();
  const fake = createGhFake();
  const head = await git(root, 'rev-parse', 'HEAD');

  await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
  await git(root, 'remote', 'set-url', '--push', 'origin', '/local/repository');

  const result = await readCaptureOwnership({ cwd: root, exec: fake.exec }, { base: null, head });

  expect(result.status).toBe('unclear');
  expect(result.reasons.length).toBeGreaterThan(0);
});

it('reads only the root commit when the range has no base', async () => {
  const { root } = await preparedReview();
  const fake = createGhFake();
  const head = await git(root, 'rev-parse', 'HEAD');

  await writeFile(join(root, 'tracked.txt'), 'other\n');
  await git(root, 'commit', '-am', 'other', '--author=Other <other@example.com>');

  const result = await readOwnership({ cwd: root, exec: fake.exec }, { base: null, head }, null);

  expect(result.status).toBe('own');
});

it('treats an empty range as own even when its head has another author', async () => {
  const { root } = await preparedReview();
  const fake = createGhFake();

  await writeFile(join(root, 'tracked.txt'), 'other\n');
  await git(root, 'commit', '-am', 'other', '--author=Other <other@example.com>');

  const head = await git(root, 'rev-parse', 'HEAD');
  const result = await readOwnership({ cwd: root, exec: fake.exec }, { base: head, head }, null);

  expect(result).toEqual({ status: 'own', reasons: [] });
});

it('does not mistake a commit with an empty author email for an empty range', async () => {
  const { root } = await preparedReview();
  const fake = createGhFake();
  const base = await git(root, 'rev-parse', 'HEAD');

  await git(root, 'commit', '--allow-empty', '-m', 'empty email', '--author=Other <>');

  const result = await readOwnership({ cwd: root, exec: fake.exec }, { base, head: 'HEAD' }, null);

  expect(result.status).toBe('other');
});

it.each([
  { name: 'missing', arguments: ['config', '--unset', 'user.email'] },
  { name: 'empty', arguments: ['config', 'user.email', ''] },
])(
  'returns unclear when the configured email is $name',
  async ({ arguments: commandArguments }) => {
    const { root } = await preparedReview();
    const fake = createGhFake();
    const head = await git(root, 'rev-parse', 'HEAD');

    await git(root, ...commandArguments);

    const result = await readOwnership({ cwd: root, exec: fake.exec }, { base: null, head }, null);

    expect(result.status).toBe('unclear');
    expect(result.reasons).toEqual([expect.stringContaining('user.email')]);
  },
);

it.each(['config user.email', 'log --format=%ae'])(
  'returns unclear when git %s fails',
  async (command) => {
    const { root } = await preparedReview();
    const fake = createGhFake();
    const head = await git(root, 'rev-parse', 'HEAD');

    await failGitCommand(command);

    const result = await readOwnership({ cwd: root, exec: fake.exec }, { base: null, head }, null);

    expect(result.status).toBe('unclear');
    expect(result.reasons).toEqual([expect.stringContaining('forced failure')]);
  },
);
