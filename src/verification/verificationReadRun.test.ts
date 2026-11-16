import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import type { RunRecord } from './records.js';
import { readRun, runRecordPath } from './verification.js';

const record: RunRecord = {
  version: 1,
  run: 'app-one',
  target: 'app',
  head: null,
  dirty: false,
  platform: { os: 'linux', arch: 'x64' },
  startedAt: '2026-11-16T10:00:00.000Z',
  treeAtLaunch: null,
  treeAtStop: null,
  launch: null,
  doctor: null,
  stop: null,
  items: [],
};

const runDirectory = (name: string, text: string | undefined): string => {
  const directory = join(temporaryDirectory(onTestFinished, 'tau-verification-read-run-'), name);

  mkdirSync(directory);

  if (text !== undefined) {
    writeFileSync(runRecordPath(directory), text);
  }

  return directory;
};

it('reads a run record whose run matches its directory as valid', async () => {
  const directory = runDirectory('app-one', JSON.stringify(record));

  expect(await readRun(directory)).toEqual({ status: 'valid', record });
});

it('reports a directory without a run record as missing', async () => {
  expect(await readRun(runDirectory('app-one', undefined))).toEqual({ status: 'missing' });
});

it('reports a run record that does not parse as malformed', async () => {
  const read = await readRun(runDirectory('app-one', '{'));

  expect(read.status).toBe('malformed');
});

it('reports a run record that names another run as malformed', async () => {
  const read = await readRun(runDirectory('app-two', JSON.stringify(record)));

  expect(read).toEqual({
    status: 'malformed',
    problem: '/run app-one does not match the directory name app-two',
  });
});
