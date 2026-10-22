import { readFileSync, statSync, writeFileSync } from 'node:fs';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import type { Task } from '../types.js';
import { nativeIdentity, seedSession } from './nativeSession.js';

const sessionTask = (): Task => {
  const directory = temporaryDirectory(onTestFinished, 'tau-native-session-');

  return {
    ...nativeIdentity(directory),
    createdAt: 1_700_000_000_000,
    parentSession: '/tmp/parent.jsonl',
    loadout: fixtureLoadout(directory),
  } as Task;
};

it('saves the session header readable by its owner only', () => {
  const task = sessionTask();

  seedSession(task);

  expect(statSync(task.nativeSessionFile).mode & 0o777).toBe(0o600);

  expect(JSON.parse(readFileSync(task.nativeSessionFile, 'utf8'))).toMatchObject({
    type: 'session',
    id: task.nativeSessionId,
    parentSession: '/tmp/parent.jsonl',
  });
});

it('refuses to overwrite an existing session file', () => {
  const task = sessionTask();

  writeFileSync(task.nativeSessionFile, 'existing\n');

  expect(() => {
    seedSession(task);
  }).toThrow('EEXIST');

  expect(readFileSync(task.nativeSessionFile, 'utf8')).toBe('existing\n');
});
