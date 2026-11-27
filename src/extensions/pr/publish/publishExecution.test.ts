import { join } from 'node:path';

import { expect, it } from 'vitest';

import { publishedUrl, verifiedCopyArguments } from './publishExecution.js';

const repository = 'github.com/sQVe/tau';

it('returns the pull request URL after another https line', () => {
  const stdout = 'https://example.com/other\nhttps://github.com/sQVe/tau/pull/8\n';

  expect(publishedUrl('pullRequest', repository, stdout)).toBe(
    'https://github.com/sQVe/tau/pull/8',
  );
});

it('returns the comment URL for a comment', () => {
  const stdout = 'https://github.com/sQVe/tau/pull/1#issuecomment-1\n';

  expect(publishedUrl('comment', repository, stdout)).toBe(
    'https://github.com/sQVe/tau/pull/1#issuecomment-1',
  );
});

it('returns the review URL from its JSON', () => {
  const stdout = JSON.stringify({
    html_url: 'https://github.com/sQVe/tau/pull/7#pullrequestreview-1',
  });

  expect(publishedUrl('review', repository, stdout)).toBe(
    'https://github.com/sQVe/tau/pull/7#pullrequestreview-1',
  );
});

it('returns null when no URL matches the repository and kind', () => {
  expect(
    publishedUrl('pullRequest', repository, 'https://github.com/sQVe/other/pull/8\n'),
  ).toBeNull();

  expect(
    publishedUrl(
      'review',
      repository,
      JSON.stringify({ html_url: 'https://github.com/sQVe/tau/pull/7' }),
    ),
  ).toBeNull();
});

it('matches the repository without case', () => {
  expect(
    publishedUrl('pullRequest', 'github.com/sqve/tau', 'https://github.com/sQVe/tau/pull/8\n'),
  ).toBe('https://github.com/sQVe/tau/pull/8');
});

const directory = '/tmp/tau-publish-test';
const first = { file: 'body.md', path: '/run/a/body.md', bytes: Buffer.from('First.\n') };
const second = { file: 'body.md', path: '/run/b/body.md', bytes: Buffer.from('Second.\n') };

it('rewrites every file argument to a unique verified copy', () => {
  const result = verifiedCopyArguments(
    ['--body-file', first.path, '--input', second.path],
    [
      { index: 1, file: first },
      { index: 3, file: second },
    ],
    directory,
  );

  expect(result.commandArguments).toEqual([
    '--body-file',
    join(directory, '1-body.md'),
    '--input',
    join(directory, '3-body.md'),
  ]);

  expect(result.copies).toEqual([
    { path: join(directory, '1-body.md'), bytes: first.bytes },
    { path: join(directory, '3-body.md'), bytes: second.bytes },
  ]);
});

it('keeps a flag-like file path as a value, not as a flag', () => {
  const flagLike = { file: 'body.md', path: '--title', bytes: Buffer.from('Flag-like.\n') };

  const result = verifiedCopyArguments(
    ['--body-file', flagLike.path],
    [{ index: 1, file: flagLike }],
    directory,
  );

  expect(result.commandArguments).toEqual(['--body-file', join(directory, '1---title')]);
});

it('refuses a command that names no file', () => {
  expect(() => verifiedCopyArguments(['pr', 'view', '7'], [], directory)).toThrow(
    'The publication command names no file to read.',
  );
});
