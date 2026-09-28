import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { fixtureLoadout } from '../fixtures/loadout.js';
import type { Task } from '../types.js';
import { readOwnedWorker } from './record.js';

const ownedRecord = (name: string): string =>
  readFileSync(new URL(`../fixtures/ownedRecords/${name}.json`, import.meta.url), 'utf8');

const readSaved = (name: string | undefined) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-owned-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

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
