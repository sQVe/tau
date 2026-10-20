import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

const hooks: { afterRead: ((path: string) => Promise<void>) | undefined } = {
  afterRead: undefined,
};

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    readFile: (async (...parameters: Parameters<typeof original.readFile>) => {
      const contents = await original.readFile(...parameters);

      const [path] = parameters;

      if (typeof path === 'string') {
        await hooks.afterRead?.(path);
      }

      return contents;
    }) as typeof original.readFile,
  };
});

const { fixture, stagingOf } = await import('./fixtures/reviewFixture.js');

it('reports a conflict, and writes nothing, when the real file disappears after collect reads it', async () => {
  const context = await fixture();
  const opened = await context.run({ action: 'open', paths: ['.tau/slices/a.md'] });

  if (opened.details.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  const realFile = context.real('slices/a.md');

  await writeFile(join(stagingOf(opened.details.command), 'slices/a.md'), 'edited\n');

  hooks.afterRead = async (path) => {
    if (path === realFile) {
      hooks.afterRead = undefined;
      await rm(realFile);
    }
  };

  const collected = await context.run({ action: 'collect', directory: opened.details.directory });

  expect(collected.details).toMatchObject({
    status: 'reviewed',
    edits: [{ path: realFile, status: 'conflict' }],
  });

  await expect(context.records()).resolves.toHaveLength(0);
  await expect(rm(realFile)).rejects.toThrow(/ENOENT/);
});
