import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

interface CopyReport {
  listeners: Record<string, number>[];
  directories: string[];
}

const harnessUrl = pathToFileURL(join(import.meta.dirname, 'temporaryDirectoryHarness.ts')).href;

const copyReport = async (onTestFinished: (cleanup: () => void) => void): Promise<CopyReport> => {
  const source = [
    `const url = ${JSON.stringify(harnessUrl)};`,
    "const events = ['exit', 'SIGHUP', 'SIGINT', 'SIGTERM'];",
    'const count = () => Object.fromEntries(events.map((event) => [event, process.listenerCount(event)]));',
    'const listeners = [];',
    'const directories = [];',
    'for (const copy of [1, 2, 3]) {',
    "  const harness = await import(url + '?copy=' + copy);",
    "  directories.push(harness.temporaryDirectory(() => {}, 'tau-harness-copy-'));",
    '  listeners.push(count());',
    '}',
    'process.stdout.write(JSON.stringify({ listeners, directories }));',
  ].join('\n');

  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
  ]);

  const report = JSON.parse(stdout) as CopyReport;

  onTestFinished(() => {
    for (const directory of report.directories) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  return report;
};

it('adds no exit or signal listeners when a fresh copy of the module tracks a directory', async ({
  onTestFinished,
}) => {
  const { listeners } = await copyReport(onTestFinished);

  expect(listeners[1]).toEqual(listeners[0]);
  expect(listeners[2]).toEqual(listeners[0]);
});

it('removes the directories of every module copy when the process exits', async ({
  onTestFinished,
}) => {
  const { directories } = await copyReport(onTestFinished);

  expect(directories).toHaveLength(3);
  expect(directories.filter((directory) => existsSync(directory))).toEqual([]);
});
