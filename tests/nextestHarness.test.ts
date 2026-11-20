import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { writeFileMap } from './fileMap.js';
import { removeDepInfoFiles } from './nextestHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const targetWithFiles = async (
  onTestFinished: (cleanup: () => void) => void,
  files: string[],
): Promise<string> => {
  const target = temporaryDirectory(onTestFinished, 'tau-nextest-layout-');

  await writeFileMap(target, Object.fromEntries(files.map((file) => [file, ''])));

  vi.stubEnv('CARGO_TARGET_DIR', target);

  return target;
};

it('removes the dep-info file that cargo keeps beside the binary in the deps layout', async ({
  onTestFinished,
}) => {
  const target = await targetWithFiles(onTestFinished, [
    'debug/deps/probe_x-1a2b.d',
    'debug/deps/probe_x-1a2b',
    'debug/deps/probe_y-3c4d.d',
  ]);

  await removeDepInfoFiles('probe_x');

  expect(existsSync(join(target, 'debug/deps/probe_x-1a2b.d'))).toBe(false);
  expect(existsSync(join(target, 'debug/deps/probe_x-1a2b'))).toBe(true);
  expect(existsSync(join(target, 'debug/deps/probe_y-3c4d.d'))).toBe(true);
});

it('removes the dep-info file that cargo keeps beside the binary in the per-package layout', async ({
  onTestFinished,
}) => {
  const target = await targetWithFiles(onTestFinished, [
    'debug/build/probe_x/1a2b/out/probe_x-1a2b.d',
    'debug/build/probe_x/1a2b/out/probe_x-1a2b',
    'debug/build/probe_y/3c4d/out/probe_y-3c4d.d',
  ]);

  await removeDepInfoFiles('probe_x');

  expect(existsSync(join(target, 'debug/build/probe_x/1a2b/out/probe_x-1a2b.d'))).toBe(false);
  expect(existsSync(join(target, 'debug/build/probe_x/1a2b/out/probe_x-1a2b'))).toBe(true);
  expect(existsSync(join(target, 'debug/build/probe_y/3c4d/out/probe_y-3c4d.d'))).toBe(true);
});

it('reports a package that has no dep-info file', async ({ onTestFinished }) => {
  const target = await targetWithFiles(onTestFinished, ['debug/deps/probe_y-3c4d.d']);

  await expect(removeDepInfoFiles('probe_x')).rejects.toThrow(
    'Found no dep-info files for probe_x',
  );

  expect(existsSync(join(target, 'debug/deps/probe_y-3c4d.d'))).toBe(true);
});
