import { execFile } from 'node:child_process';
import { symlink, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

vi.setConfig({ testTimeout: 30_000 });

const repositoryRoot = resolvePath(import.meta.dirname, '..');

const mockingFile = [
  "import * as fs from 'node:fs';",
  "import { expect, it, vi } from 'vitest';",
  "vi.mock(import('node:fs'), { spy: true });",
  "it('spies on fs', () => {",
  '  expect(vi.isMockFunction(fs.WriteStream.prototype.write)).toBe(true);',
  '});',
].join('\n');

const laterFile = [
  "import * as fs from 'node:fs';",
  "import { expect, it, vi } from 'vitest';",
  "it('sees the real fs prototypes', () => {",
  "  expect(Object.hasOwn(fs.WriteStream.prototype, 'write')).toBe(false);",
  '  expect(vi.isMockFunction(fs.WriteStream.prototype.write)).toBe(false);',
  '});',
].join('\n');

// One worker without isolation runs the files in name order, so the later file shares the
// prototypes that the mocking file changed.
const configSource = (directory: string) =>
  [
    'export default {',
    `  root: ${JSON.stringify(directory)},`,
    '  test: {',
    '    isolate: false,',
    '    maxWorkers: 1,',
    `    setupFiles: [${JSON.stringify(join(import.meta.dirname, 'testFileIsolationHarness.ts'))}],`,
    '    sequence: {',
    '      sequencer: class {',
    '        shard(files) { return files; }',
    '        sort(files) { return files.toSorted((a, b) => a.moduleId.localeCompare(b.moduleId)); }',
    '      },',
    '    },',
    '  },',
    '};',
  ].join('\n');

it('leaves the real fs prototypes to later files after a file spies on node:fs', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-file-isolation-');

  await symlink(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'a.test.ts'), mockingFile);
  await writeFile(join(directory, 'b.test.ts'), laterFile);
  await writeFile(join(directory, 'vitest.config.mjs'), configSource(directory));

  const { stdout } = await promisify(execFile)(
    join(repositoryRoot, 'node_modules', '.bin', 'vitest'),
    ['run', '--config', join(directory, 'vitest.config.mjs')],
    { cwd: directory, timeout: 25_000 },
  );

  expect(stdout).toContain('2 passed');
});
