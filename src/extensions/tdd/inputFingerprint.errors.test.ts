import type { PathLike } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { defaultTddConfig } from './config.js';
import { listInputs } from './inputFingerprint.js';

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    readdir: (async (path: PathLike, options: { withFileTypes: true }) => {
      if (String(path).endsWith('broken')) {
        throw Object.assign(new Error('input/output error'), { code: 'EIO' });
      }

      return original.readdir(path, options);
    }) as typeof original.readdir,
  };
});

it('fails the listing when a directory cannot be read for a reason other than access or absence', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-input-errors-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'broken'));

  await expect(listInputs(cwd, defaultTddConfig)).rejects.toThrow('input/output error');
});
