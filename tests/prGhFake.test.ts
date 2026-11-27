import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createGhFake } from './prGhFake.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

it('records a PATCH api call as a write, not a read', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-gh-fake-');
  const path = join(directory, 'review.json');

  await writeFile(path, '{}\n');

  const fake = createGhFake();

  const result = await fake.exec('gh', [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'PATCH',
    'repos/sQVe/tau/pulls/7/reviews',
    '--input',
    path,
  ]);

  expect(result.code).toBe(0);

  expect(fake.writes).toEqual([
    {
      key: 'api write',
      commandArguments: [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'PATCH',
        'repos/sQVe/tau/pulls/7/reviews',
        '--input',
        path,
      ],
      contents: Buffer.from('{}\n'),
    },
  ]);
});

it.each(['-f', '-F', '--field', '--raw-field'])(
  'records an api call with %s as a write, not a read',
  async (field) => {
    const fake = createGhFake();

    const commandArguments = [
      'api',
      '--hostname',
      'github.com',
      'repos/sQVe/tau/pulls/7/reviews',
      field,
      'body=Fine.',
    ];

    const result = await fake.exec('gh', commandArguments);

    expect(result.code).toBe(0);

    expect(fake.writes).toEqual([
      { key: 'api write', commandArguments, contents: Buffer.alloc(0) },
    ]);
  },
);

it('records an api call with --input but no --method as a write', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-gh-fake-');
  const path = join(directory, 'review.json');

  await writeFile(path, '{}\n');

  const fake = createGhFake();

  const commandArguments = [
    'api',
    '--hostname',
    'github.com',
    'repos/sQVe/tau/pulls/7/reviews',
    '--input',
    path,
  ];

  const result = await fake.exec('gh', commandArguments);

  expect(result.code).toBe(0);

  expect(fake.writes).toEqual([
    { key: 'api write', commandArguments, contents: Buffer.from('{}\n') },
  ]);
});

it('refuses an api write without --input', async () => {
  const fake = createGhFake();

  const result = await fake.exec('gh', [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'POST',
    'repos/sQVe/tau/pulls/7/reviews',
  ]);

  expect(result).toMatchObject({ code: 1, stderr: 'missing --input' });
  expect(fake.writes).toEqual([]);
});

it('reads an api call with an explicit GET method even when it carries a field', async () => {
  const fake = createGhFake();

  const result = await fake.exec('gh', [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    'repos/sQVe/tau/pulls/7/reviews',
    '-f',
    'body=Fine.',
  ]);

  expect(result.code).toBe(0);
  expect(fake.writes).toEqual([]);
});

it('refuses a field write whose trailing --input has no value', async () => {
  const fake = createGhFake();

  const result = await fake.exec('gh', [
    'api',
    '--hostname',
    'github.com',
    '-f',
    'body=Fine.',
    'repos/sQVe/tau/pulls/7/reviews',
    '--input',
  ]);

  expect(result).toMatchObject({ code: 1, stderr: 'missing --input' });
  expect(fake.writes).toEqual([]);
});

it('reads the api endpoint after an explicit GET method', async () => {
  const fake = createGhFake();

  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  fake.pullRequests['github.com/sQVe/tau'] = [
    {
      number: 7,
      state: 'OPEN',
      title: 'Add a feature',
      body: 'Adds it.',
      baseRefName: 'main',
      isDraft: false,
      headRefOid: 'abc123',
      headOwner: 'sQVe',
      headBranch: 'feature',
      headCommittedAt: '2026-01-02T03:04:05Z',
    },
  ];

  const result = await fake.exec('gh', [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    'repos/sQVe/tau/commits/abc123',
    '--jq',
    '.commit.committer.date',
  ]);

  expect(result.stdout).toBe('2026-01-02T03:04:05Z');
});

it('refuses an api write whose trailing --input has no value', async () => {
  const fake = createGhFake();

  const result = await fake.exec('gh', [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'POST',
    'repos/sQVe/tau/pulls/7/reviews',
    '--input',
  ]);

  expect(result).toMatchObject({ code: 1, stderr: 'missing --input' });
  expect(fake.writes).toEqual([]);
});

it('refuses an api write whose --input cannot be read', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-gh-fake-');
  const path = join(directory, 'absent.json');
  const fake = createGhFake();

  const result = await fake.exec('gh', [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'POST',
    'repos/sQVe/tau/pulls/7/reviews',
    '--input',
    path,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`could not read ${path}`);
  expect(fake.writes).toEqual([]);
});
