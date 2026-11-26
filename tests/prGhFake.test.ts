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
