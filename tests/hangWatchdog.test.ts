import { execFile } from 'node:child_process';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

vi.setConfig({ testTimeout: 30_000 });

const repositoryRoot = resolvePath(import.meta.dirname, '..');

const fileCount = 5;

const countingFile = (threadLog: string) =>
  [
    "import { appendFileSync, readdirSync } from 'node:fs';",
    "import { it } from 'vitest';",
    "it('counts live threads', () => {",
    `  appendFileSync(${JSON.stringify(threadLog)}, readdirSync('/proc/self/task').length + '\\n');`,
    '});',
  ].join('\n');

const configSource = (directory: string) =>
  [
    'export default {',
    `  root: ${JSON.stringify(directory)},`,
    '  test: {',
    '    isolate: false,',
    '    maxWorkers: 1,',
    `    setupFiles: [${JSON.stringify(join(import.meta.dirname, 'hangWatchdog.ts'))}],`,
    '  },',
    '};',
  ].join('\n');

// Each file in a shared worker starts a watchdog thread. A thread left from an earlier file adds
// one to the count of every later file.
// Threads are counted through /proc.
it.skipIf(process.platform !== 'linux')(
  'keeps one watchdog thread alive while files share a worker',
  async ({ onTestFinished }) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-hang-watchdog-');
    const threadLog = join(directory, 'threads.log');

    await symlink(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, 'vitest.config.mjs'), configSource(directory));

    for (let index = 0; index < fileCount; index += 1) {
      await writeFile(join(directory, `${index}.test.ts`), countingFile(threadLog));
    }

    const { stdout } = await promisify(execFile)(
      join(repositoryRoot, 'node_modules', '.bin', 'vitest'),
      ['run', '--config', join(directory, 'vitest.config.mjs')],
      { cwd: directory, timeout: 25_000 },
    );

    expect(stdout).toContain(`${fileCount} passed`);

    const counts = (await readFile(threadLog, 'utf8')).trim().split('\n').map(Number);
    // The first file may start shared thread pools that later files reuse.
    const laterCounts = new Set(counts.slice(1));

    expect(counts).toHaveLength(fileCount);
    expect(laterCounts.size).toBe(1);
  },
);
