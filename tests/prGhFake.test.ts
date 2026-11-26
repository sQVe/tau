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
  expect(fake.writes.map((write) => write.key)).toEqual(['api write']);
});
