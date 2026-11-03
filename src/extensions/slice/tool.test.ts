import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { createTemporaryBareRoot } from '../../../tests/gitRepository.js';
import { createLinearFake } from '../../../tests/linearFake.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { run, savedPlan, setUp } from './fixtures/sliceToolHarness.js';

describe('slice tool bare repository root', () => {
  it('prepares, reads, and applies a draft in the bare root', async () => {
    const { root, directory, read, apply } = await setUp('version-1.json', () =>
      createTemporaryBareRoot(onTestFinished),
    );

    expect(directory).toBe(join(root, '.tau', 'slices', 'planning'));
    expect(await readFile(join(root, '.tau', '.gitignore'), 'utf8')).toMatch(/\*\n$/);
    expect((await read())['problems']).toEqual([]);

    const result = await apply();

    expect(result['status']).toBe('applied');
    expect(result.directory).toBe(join(root, '.tau', 'slices', 'me-1'));
    expect((await savedPlan(result.directory)).container.identifier).toBe('ME-1');
  });

  it('prepares at the bare root from a nested directory', async () => {
    const root = await createTemporaryBareRoot(onTestFinished);
    const nested = join(root, 'nested');

    await mkdir(nested);

    const result = await run(createLinearFake(), noUiContext(nested), {
      action: 'prepare',
      id: 'planning',
    });

    expect(result.directory).toBe(join(root, '.tau', 'slices', 'planning'));
  });
});
