import { cpSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished as afterTest } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { TaskFormatError } from './records.js';
import { readStartupFailure, recordStartupFailure } from './startupFailure.js';

const fixturePath = (name: string): URL =>
  new URL(
    `./fixtures/startupErrors/${name}.${name === 'unparseable' ? 'txt' : 'json'}`,
    import.meta.url,
  );

const taskDirectory = (): string => {
  const directory = temporaryDirectory(afterTest, 'tau-startup-failure-');

  return directory;
};

const savedWith = (name: string): string => {
  const directory = taskDirectory();

  cpSync(fixturePath(name), join(directory, 'startupError.json'));

  return directory;
};

const snapshot = (directory: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), 'utf8')]),
  );

it.each([
  {
    fixture: 'current',
    evidence: {
      status: 'current',
      failure: { version: 1, kind: 'failed', message: 'Saved model changed.' },
    },
  },
  { fixture: 'newer', evidence: { status: 'newer' } },
  { fixture: 'malformed', evidence: { status: 'malformed' } },
  { fixture: 'unparseable', evidence: { status: 'malformed' } },
])('reads the $fixture fixture without changing the directory', ({ fixture, evidence }) => {
  const directory = savedWith(fixture);
  const before = snapshot(directory);

  expect(readStartupFailure(directory)).toEqual(evidence);
  expect(snapshot(directory)).toEqual(before);
});

it('reads a missing record as missing and leaves the directory empty', () => {
  const directory = taskDirectory();

  expect(readStartupFailure(directory)).toEqual({ status: 'missing' });
  expect(readdirSync(directory)).toEqual([]);
});

it('writes the same record as the frozen retired-task fixture and keeps the first failure', () => {
  const directory = taskDirectory();

  const retired = new Error(
    'Saved task is unreadable: Task saved in a retired format; start a fresh task instead.',
    { cause: new TaskFormatError('retired', 'retired format') },
  );

  recordStartupFailure(directory, retired);
  recordStartupFailure(directory, new Error('later'));

  const frozen = readFileSync(fixturePath('retired-task'), 'utf8');

  const written: unknown = JSON.parse(readFileSync(join(directory, 'startupError.json'), 'utf8'));

  expect(written).toEqual(JSON.parse(frozen));
});

it('records kind taskNewer for a newer task format and failed otherwise', () => {
  const newer = taskDirectory();
  const plain = taskDirectory();

  recordStartupFailure(newer, new Error('top', { cause: new TaskFormatError('newer', 'n') }));
  recordStartupFailure(plain, new Error('plain'));

  expect(readStartupFailure(newer)).toMatchObject({ failure: { kind: 'taskNewer' } });
  expect(readStartupFailure(plain)).toMatchObject({ failure: { kind: 'failed' } });
});

it('saves a nonempty message for an error without one that the manager reads as current', () => {
  const directory = taskDirectory();

  recordStartupFailure(directory, Object.assign(new Error('placeholder'), { message: '' }));

  const evidence = readStartupFailure(directory);

  expect(evidence.status).toBe('current');
  expect(evidence.status === 'current' && evidence.failure.message).not.toBe('');
});
