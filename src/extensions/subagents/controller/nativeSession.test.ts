import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { fixtureLoadout } from '../fixtures/loadout.js';
import type { Task } from '../types.js';
import { nativeIdentity, seedSession } from './nativeSession.js';

const sessionTask = (): Task => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-native-session-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

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
