import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { git } from '../../tests/gitRepository.js';
import { createGhFake, pullRequest } from '../../tests/prGhFake.js';
import { preparedReview } from './fixtures/reviewDirectoryHarness.js';
import { captureReviewDirectory } from './generation.js';

it.each([
  { author: 'sQVe', status: 'own' },
  { author: 'someone', status: 'other' },
])(
  'returns $status ownership for a PR by $author without saving ownership',
  async ({ author, status }) => {
    const { root, directory } = await preparedReview();
    const fake = createGhFake();

    await git(root, 'checkout', '-b', 'feature');
    await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
    await writeFile(join(root, 'tracked.txt'), 'changed\n');
    fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };
    fake.pullRequests['github.com/sQVe/tau'] = [pullRequest({ author })];

    const result = await captureReviewDirectory(
      root,
      directory,
      { kind: 'workingTree', base: 'HEAD' },
      { cwd: root, exec: fake.exec, signal: undefined },
    );

    const saved = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as unknown;

    expect(result).toMatchObject({ ownership: { status } });
    expect(saved).not.toHaveProperty('ownership');
  },
);

it('keeps a completed capture when reading its PR viewer fails', async () => {
  const { root, directory } = await preparedReview();
  const fake = createGhFake();

  await git(root, 'checkout', '-b', 'feature');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
  await writeFile(join(root, 'tracked.txt'), 'changed\n');
  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };
  fake.pullRequests['github.com/sQVe/tau'] = [pullRequest()];
  fake.failCommand('api user');

  const result = await captureReviewDirectory(
    root,
    directory,
    { kind: 'workingTree', base: 'HEAD' },
    { cwd: root, exec: fake.exec },
  );

  const saved = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as unknown;

  expect(result.ownership).toEqual({
    status: 'unclear',
    reasons: [expect.stringContaining('api user')],
  });

  expect(result.empty).toBe(false);
  expect(saved).toMatchObject({ hash: result.hash, head: result.head });
  expect(saved).not.toHaveProperty('ownership');
});

it('uses the captured root commit rather than a later HEAD for ownership', async () => {
  const { root, directory } = await preparedReview();
  const fake = createGhFake();
  const commit = await git(root, 'rev-parse', 'HEAD');

  await writeFile(join(root, 'tracked.txt'), 'other\n');
  await git(root, 'commit', '-am', 'other', '--author=Other <other@example.com>');

  const result = await captureReviewDirectory(
    root,
    directory,
    { kind: 'rootCommit', commit },
    { cwd: root, exec: fake.exec },
  );

  expect(result.ownership.status).toBe('own');
});

it('returns own ownership for only user commits on a GitHub branch without an open PR', async () => {
  const { root, directory } = await preparedReview();
  const fake = createGhFake();
  const base = await git(root, 'rev-parse', 'HEAD');

  await git(root, 'checkout', '-b', 'feature');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  await writeFile(join(root, 'tracked.txt'), 'own\n');
  await git(root, 'commit', '-am', 'own');

  const result = await captureReviewDirectory(
    root,
    directory,
    { kind: 'range', from: base, to: 'HEAD' },
    { cwd: root, exec: fake.exec },
  );

  expect(result.ownership).toEqual({ status: 'own', reasons: [] });
});

it('uses the range endpoint for ownership when HEAD has a later commit by another author', async () => {
  const { root, directory } = await preparedReview();
  const fake = createGhFake();
  const from = await git(root, 'rev-parse', 'HEAD');

  await writeFile(join(root, 'tracked.txt'), 'own\n');
  await git(root, 'commit', '-am', 'own');

  const to = await git(root, 'rev-parse', 'HEAD');

  await writeFile(join(root, 'tracked.txt'), 'other\n');
  await git(root, 'commit', '-am', 'other', '--author=Other <other@example.com>');

  const result = await captureReviewDirectory(
    root,
    directory,
    { kind: 'range', from, to },
    { cwd: root, exec: fake.exec },
  );

  expect(result.ownership).toEqual({ status: 'own', reasons: [] });
});

it('keeps root ownership pinned when its named revision moves during GitHub reads', async () => {
  const { root, directory } = await preparedReview();
  const fake = createGhFake();

  await git(root, 'branch', 'captured-root');
  await git(root, 'checkout', '-b', 'feature');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
  await writeFile(join(root, 'tracked.txt'), 'other\n');
  await git(root, 'commit', '-am', 'other', '--author=Other <other@example.com>');
  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  const exec: typeof fake.exec = async (...callArguments) => {
    await git(root, 'branch', '--force', 'captured-root', 'HEAD');

    return fake.exec(...callArguments);
  };

  const result = await captureReviewDirectory(
    root,
    directory,
    { kind: 'rootCommit', commit: 'captured-root' },
    { cwd: root, exec },
  );

  expect(result.ownership).toEqual({ status: 'own', reasons: [] });
});

it('returns unclear ownership for mixed authors in the capture range without a PR', async () => {
  const { root, directory } = await preparedReview();
  const fake = createGhFake();
  const base = await git(root, 'rev-parse', 'HEAD');

  await git(root, 'checkout', '-b', 'feature');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  await writeFile(join(root, 'tracked.txt'), 'own\n');
  await git(root, 'commit', '-am', 'own');
  await writeFile(join(root, 'tracked.txt'), 'other\n');
  await git(root, 'commit', '-am', 'other', '--author=Other <other@example.com>');

  const result = await captureReviewDirectory(
    root,
    directory,
    { kind: 'range', from: base, to: 'HEAD' },
    { cwd: root, exec: fake.exec, signal: undefined },
  );

  expect(result).toMatchObject({ ownership: { status: 'unclear' } });
  expect(result.ownership.reasons.length).toBeGreaterThan(0);
});
