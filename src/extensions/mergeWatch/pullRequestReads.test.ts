import { expect, it } from 'vitest';

import { createExecFake, failedResult, succeededResult } from '../../../tests/execFake.js';
import type { ExecResult } from '../../../tests/execFake.js';
import { readMergedPullRequest } from './pullRequestReads.js';

const url = 'https://github.com/owner/repo/pull/42';

const mergedOutput = JSON.stringify({
  number: 42,
  headRefName: 'me-7-change',
  createdAt: '2026-11-01T00:00:00.000Z',
  mergedAt: '2026-11-02T00:00:00.000Z',
});

const readWith = (result: ExecResult, target = url) => {
  const execFake = createExecFake<'merged'>({
    keyOf: () => 'merged',
    handlerFor: () => () => result,
  });

  const read = readMergedPullRequest({ exec: execFake.exec, cwd: '/repository' }, target);

  return { execFake, read };
};

it('reads the repository, branch, creation time, and merge time of a merged pull request', async () => {
  const { execFake, read } = readWith(succeededResult(mergedOutput));

  await expect(read).resolves.toEqual({
    repository: 'github.com/owner/repo',
    number: 42,
    url,
    headBranch: 'me-7-change',
    createdAt: '2026-11-01T00:00:00.000Z',
    mergedAt: '2026-11-02T00:00:00.000Z',
  });

  expect(execFake.calls[0]?.commandArguments).toEqual([
    'pr',
    'view',
    url,
    '--json',
    'number,headRefName,createdAt,mergedAt',
  ]);
});

const invalidUrls = [
  { name: 'names no repository path', target: 'https://github.com' },
  { name: 'names no pull request', target: 'https://github.com/owner/repo' },
  { name: 'names no pull request segment', target: 'https://github.com/owner/repo/merge/7' },
  { name: 'names a pull request without a number', target: 'https://github.com/owner/repo/pull' },
  {
    name: 'names a pull request with a non-numeric number',
    target: 'https://github.com/owner/repo/pull/seven',
  },
  {
    name: 'names a pull request with a number that starts with a non-digit',
    target: 'https://github.com/owner/repo/pull/x7',
  },
  {
    name: 'names a pull request with a number that ends with a non-digit',
    target: 'https://github.com/owner/repo/pull/7x',
  },
  {
    name: 'names a pull request with extra path segments',
    target: 'https://github.com/owner/repo/pull/7/files',
  },
  { name: 'is not a remote URL', target: 'not a url' },
];

it.each(invalidUrls.map((row) => [row.name, row] as const))(
  'returns undefined when the URL %s',
  async (_name, { target }) => {
    const { execFake, read } = readWith(succeededResult(mergedOutput), target);

    await expect(read).resolves.toBeUndefined();
    expect(execFake.calls).toEqual([]);
  },
);

it('returns undefined when the merged pull request read fails', async () => {
  const { read } = readWith(failedResult('HTTP 502'));

  await expect(read).resolves.toBeUndefined();
});

it('returns undefined when the merged pull request read prints unexpected output', async () => {
  const { read } = readWith(succeededResult('{"number":"7"}'));

  await expect(read).resolves.toBeUndefined();
});
