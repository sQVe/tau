import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { fixtureLoadout } from './fixtures/loadout.js';
import { validateNative } from './native.js';
import type { NativeTask } from './types.js';

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-native-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const task: NativeTask = {
    version: 1,
    taskId: 'task',
    task: 'Inspect.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent',
    ownerId: 'owner',
    nativeSessionId: 'native',
    nativeSessionFile: join(directory, 'native.jsonl'),
    createdAt: 1000,
    deadline: 20000,
    cancellationBudget: 1000,
    tree: {
      rootSession: join(directory, 'parent.jsonl'),
      rootSessionId: 'parent',
      monotonicDeadline: 20000,
    },
    loadout: fixtureLoadout(directory),
  };
  const header = {
    type: 'session',
    version: 3,
    id: 'native',
    cwd: directory,
    parentSession: task.parentSession,
  };
  writeFileSync(task.nativeSessionFile, JSON.stringify(header));

  return { directory, task, header };
};

it('inspects native headers without newline repair or transcript mutation', () => {
  const { task } = fixture();
  const before = readFileSync(task.nativeSessionFile);
  const native = validateNative(task, task);

  expect(native.header.id).toBe(task.nativeSessionId);
  expect(readFileSync(task.nativeSessionFile)).toEqual(before);
});

it.each([
  'missing',
  'empty',
  'malformed',
  'directory',
  'symlink',
  'version',
  'identity',
  'cwd',
  'lineage',
] as const)('refuses %s native files without creating fresh work', (failure) => {
  const { directory, task, header } = fixture();
  const modifications = {
    version: { version: 99 },
    identity: { id: 'wrong' },
    cwd: { cwd: '/' },
    lineage: { parentSession: join(directory, 'wrong.jsonl') },
  };

  if (failure === 'missing' || failure === 'directory' || failure === 'symlink') {
    rmSync(task.nativeSessionFile);
  }

  if (failure === 'directory') {
    mkdirSync(task.nativeSessionFile);
  } else if (failure === 'symlink') {
    const target = join(directory, 'target.jsonl');
    writeFileSync(target, JSON.stringify(header));
    symlinkSync(target, task.nativeSessionFile);
  } else if (failure === 'empty' || failure === 'malformed') {
    writeFileSync(task.nativeSessionFile, failure === 'empty' ? '' : '{');
  } else if (failure in modifications) {
    writeFileSync(
      task.nativeSessionFile,
      JSON.stringify({ ...header, ...modifications[failure as keyof typeof modifications] }),
    );
  }

  expect(() => validateNative(task, task)).toThrow('Native follow-up prevalidation refused');
  expect(existsSync(task.nativeSessionFile)).toBe(failure !== 'missing');
});
