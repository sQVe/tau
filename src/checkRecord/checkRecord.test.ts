import { copyFile, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { listSavedLogs, readCheckRecord, recordPathFor, saveCheckRecord } from './checkRecord.js';
import { decideReuse } from './reuseDecision.js';

const fixturePath = (name: string) => new URL(`fixtures/checkRecords/${name}`, import.meta.url);

const identity = {
  tree: '1111111111111111111111111111111111111111',
  argv: ['pnpm', 'check'],
};

const validRecord = {
  status: 'valid',
  record: { version: 3, ...identity, passed: true },
};

it('reads the current record fixture and a record it saved', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const logPath = join(directory, 'run.log');

  await saveCheckRecord(logPath, identity, true);

  expect(await readCheckRecord(fixturePath('current.json').pathname)).toEqual({
    status: 'valid',
    record: { version: 3, ...identity, passed: true },
  });

  expect(await readCheckRecord(recordPathFor(logPath))).toEqual({
    status: 'valid',
    record: { version: 3, ...identity, passed: true },
  });

  expect(JSON.parse(await readFile(fixturePath('current.json'), 'utf8'))).toEqual({
    version: 3,
    passed: true,
    ...identity,
  });
});

it('reports a missing record as missing', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');

  expect(await readCheckRecord(join(directory, 'none.json'))).toEqual({ status: 'missing' });
});

it('reports malformed records as malformed', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const notJson = join(directory, 'not-json.json');

  await writeFile(notJson, '{ broken');

  expect(await readCheckRecord(fixturePath('malformed.json').pathname)).toEqual({
    status: 'malformed',
  });

  expect(await readCheckRecord(notJson)).toEqual({ status: 'malformed' });
  expect(await readCheckRecord(fixturePath('v4.json').pathname)).toEqual({ status: 'malformed' });
});

it('lists logs newest first and keeps a malformed record from hiding the others', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const checks = join(directory, 'checks');
  await mkdir(checks);

  await writeFile(join(checks, 'a.log'), 'old');
  await saveCheckRecord(join(checks, 'a.log'), identity, true);
  await writeFile(join(checks, 'b.log'), 'bad');
  await writeFile(join(checks, 'b.json'), '{ broken');

  await copyFile(fixturePath('v4.json'), join(checks, 'd.json'));
  await writeFile(join(checks, 'd.log'), 'newer');

  await writeFile(
    join(checks, 'c.json'),
    JSON.stringify({ version: 3, ...identity, passed: true }),
  );

  const saved = await listSavedLogs(checks);

  expect(saved).toEqual([
    { logPath: join(checks, 'd.log'), read: { status: 'malformed' }, logExists: true },
    { logPath: join(checks, 'c.log'), read: validRecord, logExists: false },
    { logPath: join(checks, 'b.log'), read: { status: 'malformed' }, logExists: true },
    { logPath: join(checks, 'a.log'), read: validRecord, logExists: true },
  ]);

  expect(decideReuse(identity, saved)).toEqual({
    status: 'reuse',
    logPath: join(checks, 'a.log'),
  });
});

it('lists no logs when the checks directory is missing', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');

  expect(await listSavedLogs(join(directory, 'checks'))).toEqual([]);
});

it('reports a record with an extra field as malformed', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const path = join(directory, 'extra.json');

  await writeFile(path, JSON.stringify({ version: 3, ...identity, passed: true, extra: true }));

  expect(await readCheckRecord(path)).toEqual({ status: 'malformed' });
});

it('throws a record read error that is not a missing file', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');

  await mkdir(join(directory, 'run.json'));

  await expect(readCheckRecord(join(directory, 'run.json'))).rejects.toMatchObject({
    code: 'EISDIR',
  });
});

it('throws when the checks path cannot be listed', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const checks = join(directory, 'checks');

  await writeFile(checks, 'not a directory');

  await expect(listSavedLogs(checks)).rejects.toMatchObject({ code: 'ENOTDIR' });
});

it('throws when a log cannot be checked for existence', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');

  await writeFile(
    join(directory, 'loop.json'),
    JSON.stringify({ version: 3, ...identity, passed: true }),
  );

  await symlink('loop.log', join(directory, 'loop.log'));

  await expect(listSavedLogs(directory)).rejects.toMatchObject({ code: 'ELOOP' });
});

it('keeps a directory name that ends in .log out of the record path', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const logDirectory = join(directory, 'checks.log');
  const logPath = join(logDirectory, 'run.log');

  await mkdir(logDirectory);
  await writeFile(logPath, 'output');
  await saveCheckRecord(logPath, identity, true);

  expect(recordPathFor(logPath)).toBe(join(logDirectory, 'run.json'));

  expect(await listSavedLogs(logDirectory)).toEqual([
    { logPath, read: validRecord, logExists: true },
  ]);
});

it('keeps a directory name that ends in .json out of the log path', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const checks = join(directory, 'checks.json');

  await mkdir(checks);
  await writeFile(join(checks, 'run.log'), 'output');
  await saveCheckRecord(join(checks, 'run.log'), identity, true);

  expect(await listSavedLogs(checks)).toEqual([
    { logPath: join(checks, 'run.log'), read: validRecord, logExists: true },
  ]);
});

it.each([
  { name: 'an empty tree', change: { tree: '' } },
  { name: 'an empty command', change: { argv: [] } },
  { name: 'an empty command word', change: { argv: ['pnpm', ''] } },
])('reports a record with $name as malformed', async ({ change }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const path = join(directory, 'empty.json');

  await writeFile(path, JSON.stringify({ version: 3, ...identity, passed: true, ...change }));

  expect(await readCheckRecord(path)).toEqual({ status: 'malformed' });
});

it('reads a failing record as valid with passed false', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const logPath = join(directory, 'run.log');

  await saveCheckRecord(logPath, identity, false);

  expect(await readCheckRecord(recordPathFor(logPath))).toEqual({
    status: 'valid',
    record: { version: 3, ...identity, passed: false },
  });
});

it.each(['v1.json', 'v2.json'])(
  'reads the older record %s as malformed so it is never reused',
  async (name) => {
    expect(await readCheckRecord(fixturePath(name).pathname)).toEqual({ status: 'malformed' });
  },
);

it('refuses to save a state without a tree and writes no record', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const logPath = join(directory, 'run.log');

  await expect(saveCheckRecord(logPath, { ...identity, tree: null }, true)).rejects.toThrow(
    'submodule',
  );

  expect(await readCheckRecord(recordPathFor(logPath))).toEqual({ status: 'missing' });
});

it('leaves no temporary file when the record cannot replace its path', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-check-record-');
  const logPath = join(directory, 'run.log');

  await mkdir(recordPathFor(logPath));

  await expect(saveCheckRecord(logPath, identity, true)).rejects.toThrow(
    /EISDIR|ENOTEMPTY|EEXIST|EPERM/u,
  );

  expect(await readdir(directory)).toEqual(['run.json']);
});
