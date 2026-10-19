import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { fixtureLoadout } from './fixtures/loadout.js';
import { validateNative } from './native.js';
import type { Task } from './types.js';

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-native-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const task: Task = {
    version: 11,
    taskId: 'task',
    task: 'Inspect.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent',
    nativeSessionId: 'native',
    nativeSessionFile: join(directory, 'native.jsonl'),
    createdAt: 1000,
    deadline: 20000,
    cancellationBudget: 1000,
    monotonicDeadline: 20000,
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

const openDescriptorCount = () => readdirSync('/dev/fd').length;

it('inspects native headers without newline repair or transcript mutation', () => {
  const { task } = fixture();
  const before = readFileSync(task.nativeSessionFile);
  const native = validateNative(task);

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
] as const)('refuses %s native files without creating fresh work', (failure) => {
  const { directory, task, header } = fixture();

  const modifications = {
    version: { version: 99 },
    identity: { id: 'wrong' },
    cwd: { cwd: '/' },
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

  expect(() => validateNative(task)).toThrow('Native follow-up prevalidation refused');
  expect(existsSync(task.nativeSessionFile)).toBe(failure !== 'missing');
});

it('reads the header line of a session that already has entries', () => {
  const { task, header } = fixture();

  writeFileSync(
    task.nativeSessionFile,
    `${JSON.stringify(header)}\n${JSON.stringify({ type: 'message' })}\n`,
  );

  expect(validateNative(task).header.id).toBe(task.nativeSessionId);
});

it('reports the same session file as unchanged', () => {
  const { task } = fixture();

  expect(isDeepStrictEqual(validateNative(task), validateNative(task))).toBe(true);
});

it.each([
  {
    name: 'appended entries',
    change: (path: string) => {
      appendFileSync(path, '\n{}');
    },
  },
  {
    name: 'a rewrite of the same size',
    change: (path: string) => {
      const modified = statSync(path).mtime;

      writeFileSync(path, readFileSync(path));
      utimesSync(path, modified, new Date(modified.getTime() + 1500));
    },
  },
])('notices $name in the session file', ({ change }) => {
  const { task } = fixture();
  const before = validateNative(task);

  change(task.nativeSessionFile);

  expect(isDeepStrictEqual(validateNative(task), before)).toBe(false);
});

it('closes the session file after validation', () => {
  const { task } = fixture();
  const before = openDescriptorCount();

  validateNative(task);

  expect(openDescriptorCount()).toBe(before);
});

it('closes the session file after a refused validation', () => {
  const { task } = fixture();

  writeFileSync(task.nativeSessionFile, '{');

  const before = openDescriptorCount();

  expect(() => validateNative(task)).toThrow('Native follow-up prevalidation refused');
  expect(openDescriptorCount()).toBe(before);
});
