import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import type { Task } from '../types.js';
import { readOwnedWorker } from './record.js';

const ownedRecord = (name: string): string =>
  readFileSync(new URL(`../fixtures/ownedRecords/${name}.json`, import.meta.url), 'utf8');

const readSaved = (name: string | undefined) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-owned-');

  if (name !== undefined) {
    writeFileSync(join(directory, 'owned.json'), ownedRecord(name));
  }

  const task = {
    taskId: 'task',
    nativeSessionFile: '/tmp/task/session.jsonl',
    loadout: fixtureLoadout(directory),
  };

  return () => readOwnedWorker(directory, task as Task);
};

it('reads current Pi ownership as saved', () => {
  expect(readSaved('current-pi')()).toEqual(JSON.parse(ownedRecord('current-pi')));
});

it.each([
  ['retired-pi', 'retired format; start a fresh task'],
  ['malformed-pi', 'Invalid saved worker ownership.'],
  [undefined, 'No saved worker ownership.'],
] as const)('refuses %s ownership', (name, message) => {
  expect(readSaved(name)).toThrow(message);
});

const readInline = (content: string, nativeSessionFile = '/tmp/task/session.jsonl') => {
  const directory = temporaryDirectory(onTestFinished, 'tau-owned-');

  writeFileSync(join(directory, 'owned.json'), content);

  return () => readOwnedWorker(directory, { taskId: 'task', nativeSessionFile } as Task);
};

it.each([
  ['null', 'null'],
  ['a number', '5'],
  ['an empty object', '{}'],
  ['an unversioned non-Pi object', '{"kind":"shell"}'],
  [
    'a versioned record missing a field',
    JSON.stringify({ ...JSON.parse(ownedRecord('current-pi')), terminalId: undefined }),
  ],
])('refuses %s as invalid ownership', (_name, content) => {
  expect(readInline(content)).toThrow(/invalid/iu);
});

it('refuses ownership saved for another session', () => {
  expect(readInline(ownedRecord('current-pi'), '/tmp/other/session.jsonl')).toThrow(
    'does not match the task',
  );
});
