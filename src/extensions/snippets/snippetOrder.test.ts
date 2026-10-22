import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished as afterThisTest, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { loadSnippets } from './snippet.js';

// The directory lists its files in reverse alphabetical order.
vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const readdir = async (directory: string) => {
    const entries = await original.readdir(directory, { withFileTypes: true });

    return entries.toSorted((first, second) => second.name.localeCompare(first.name));
  };

  return { ...original, readdir: readdir as unknown as typeof original.readdir };
});

it('sorts by id whatever order the directory lists the files in', async () => {
  const directory = temporaryDirectory(afterThisTest, 'tau-snippets-order-');

  for (const id of ['alpha', 'bravo', 'charlie']) {
    await writeFile(join(directory, `${id}.md`), `---\nname: ${id}\n---\nBody.\n`);
  }

  const snippets = await loadSnippets(directory);

  expect(snippets.map((snippet) => snippet.id)).toEqual(['alpha', 'bravo', 'charlie']);
});
