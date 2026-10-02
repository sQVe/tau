import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

const prepareScript = join(import.meta.dirname, 'prepare.ts');

let packageDirectory: string;

beforeEach(async () => {
  packageDirectory = await mkdtemp(join(tmpdir(), 'tau-prepare-'));
});

afterEach(async () => {
  await rm(packageDirectory, { recursive: true, force: true });
});

const runPrepare = () =>
  spawnSync(process.execPath, [prepareScript], { cwd: packageDirectory, encoding: 'utf8' });

const installFakeVitePlus = async (exitCode: number) => {
  const binDirectory = join(packageDirectory, 'node_modules', '.bin');

  await mkdir(binDirectory, { recursive: true });

  await writeFile(
    join(binDirectory, 'vp'),
    `#!/bin/sh\necho "$@" > "${join(packageDirectory, 'vp-arguments')}"\nexit ${exitCode}\n`,
  );

  await chmod(join(binDirectory, 'vp'), 0o755);
};

it('succeeds without running anything when Vite+ is not installed', async () => {
  const result = runPrepare();

  expect(result.status).toBe(0);
  expect(await readdir(packageDirectory)).toEqual([]);
});

it('runs vp config when Vite+ is installed', async () => {
  await installFakeVitePlus(0);

  const result = runPrepare();

  expect(result.status).toBe(0);
  expect(await readFile(join(packageDirectory, 'vp-arguments'), 'utf8')).toBe('config\n');
});

it('fails when vp config fails', async () => {
  await installFakeVitePlus(3);

  const result = runPrepare();

  expect(result.status).toBe(3);
});
