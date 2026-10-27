import type { PathLike } from 'node:fs';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
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

      if (String(path).endsWith('vanished')) {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }

      if (String(path).endsWith('replaced')) {
        throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      }

      return original.readdir(path, options);
    }) as typeof original.readdir,
  };
});

it('fails the listing when a directory cannot be read for a reason other than absence', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-errors-');
  await mkdir(join(cwd, 'broken'));

  await expect(listInputs(cwd, defaultTddConfig)).rejects.toThrow('input/output error');
});

it('lists the other inputs when a directory vanishes or is replaced by a file while listing', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-errors-');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/a.ts'), 'one');
  await mkdir(join(cwd, 'vanished'));
  await mkdir(join(cwd, 'replaced'));

  const config = { ...defaultTddConfig, productionGlobs: ['**/*.ts'] };

  expect(await listInputs(cwd, config)).toEqual(['src/a.ts']);
});

it('fails the listing when a symlink target is behind an unreadable directory', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-errors-');
  await mkdir(join(cwd, 'src'));
  await mkdir(join(cwd, 'locked'));
  await writeFile(join(cwd, 'locked/value.ts'), 'one');
  await symlink('../locked/value.ts', join(cwd, 'src/link.ts'));
  await chmod(join(cwd, 'locked'), 0);
  onTestFinished(() => chmod(join(cwd, 'locked'), 0o755));

  const config = { ...defaultTddConfig, productionGlobs: ['**/*.ts'], excludedGlobs: ['locked'] };

  await expect(listInputs(cwd, config)).rejects.toThrow('EACCES');
});
