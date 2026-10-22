import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { listSavedLogs, readCheckRecord, recordPathFor, saveCheckRecord } from './checkRecord.js';
import { decideReuse } from './reuseDecision.js';

const fixturePath = (name: string) => new URL(`fixtures/checkRecords/${name}`, import.meta.url);

const identity = {
  head: '1111111111111111111111111111111111111111',
  base: '2222222222222222222222222222222222222222',
  argv: ['pnpm', 'check'],
  fingerprint: '3333333333333333333333333333333333333333333333333333333333333333',
};

const validRecord = {
  status: 'valid',
  record: { version: 2, ...identity, passed: true },
};

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-check-record-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

it('reads the current record fixture and a record it saved', async () => {
  const directory = await temporaryDirectory();
  const logPath = join(directory, 'run.log');

  await saveCheckRecord(logPath, identity, true);

  expect(await readCheckRecord(fixturePath('current.json').pathname)).toEqual({
    status: 'valid',
    record: { version: 2, ...identity, passed: true },
  });

  expect(await readCheckRecord(recordPathFor(logPath))).toEqual({
    status: 'valid',
    record: { version: 2, ...identity, passed: true },
  });

  expect(JSON.parse(await readFile(fixturePath('current.json'), 'utf8'))).toEqual({
    version: 2,
    passed: true,
    ...identity,
  });
});

it('reports a missing record as missing', async () => {
  const directory = await temporaryDirectory();

  expect(await readCheckRecord(join(directory, 'none.json'))).toEqual({ status: 'missing' });
});

it('reports malformed records as malformed', async () => {
  const directory = await temporaryDirectory();
  const notJson = join(directory, 'not-json.json');

  await writeFile(notJson, '{ broken');

  expect(await readCheckRecord(fixturePath('malformed.json').pathname)).toEqual({
    status: 'malformed',
  });

  expect(await readCheckRecord(notJson)).toEqual({ status: 'malformed' });
  expect(await readCheckRecord(fixturePath('v3.json').pathname)).toEqual({ status: 'malformed' });
});

it('lists logs newest first and keeps a malformed record from hiding the others', async () => {
  const directory = await temporaryDirectory();
  const checks = join(directory, 'checks');
  await mkdir(checks);

  await writeFile(join(checks, 'a.log'), 'old');
  await saveCheckRecord(join(checks, 'a.log'), identity, true);
  await writeFile(join(checks, 'b.log'), 'bad');
  await writeFile(join(checks, 'b.json'), '{ broken');

  await copyFile(fixturePath('v3.json'), join(checks, 'd.json'));
  await writeFile(join(checks, 'd.log'), 'newer');

  await writeFile(
    join(checks, 'c.json'),
    JSON.stringify({ version: 2, ...identity, passed: true }),
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
  const directory = await temporaryDirectory();

  expect(await listSavedLogs(join(directory, 'checks'))).toEqual([]);
});

it('reports a record with an extra field as malformed', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'extra.json');

  await writeFile(path, JSON.stringify({ version: 2, ...identity, passed: true, extra: true }));

  expect(await readCheckRecord(path)).toEqual({ status: 'malformed' });
});

it('throws a record read error that is not a missing file', async () => {
  const directory = await temporaryDirectory();

  await mkdir(join(directory, 'run.json'));

  await expect(readCheckRecord(join(directory, 'run.json'))).rejects.toMatchObject({
    code: 'EISDIR',
  });
});

it('throws when the checks path cannot be listed', async () => {
  const directory = await temporaryDirectory();
  const checks = join(directory, 'checks');

  await writeFile(checks, 'not a directory');

  await expect(listSavedLogs(checks)).rejects.toMatchObject({ code: 'ENOTDIR' });
});

it('throws when a log cannot be checked for existence', async () => {
  const directory = await temporaryDirectory();

  await writeFile(
    join(directory, 'loop.json'),
    JSON.stringify({ version: 2, ...identity, passed: true }),
  );

  await symlink('loop.log', join(directory, 'loop.log'));

  await expect(listSavedLogs(directory)).rejects.toMatchObject({ code: 'ELOOP' });
});

it('keeps a directory name that ends in .log out of the record path', async () => {
  const directory = await temporaryDirectory();
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
  const directory = await temporaryDirectory();
  const checks = join(directory, 'checks.json');

  await mkdir(checks);
  await writeFile(join(checks, 'run.log'), 'output');
  await saveCheckRecord(join(checks, 'run.log'), identity, true);

  expect(await listSavedLogs(checks)).toEqual([
    { logPath: join(checks, 'run.log'), read: validRecord, logExists: true },
  ]);
});

it.each([
  { name: 'an empty head', change: { head: '' } },
  { name: 'an empty base', change: { base: '' } },
  { name: 'an empty fingerprint', change: { fingerprint: '' } },
  { name: 'an empty command', change: { argv: [] } },
  { name: 'an empty command word', change: { argv: ['pnpm', ''] } },
])('reports a record with $name as malformed', async ({ change }) => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'empty.json');

  await writeFile(path, JSON.stringify({ version: 2, ...identity, passed: true, ...change }));

  expect(await readCheckRecord(path)).toEqual({ status: 'malformed' });
});

it('reads a failing record as valid with passed false', async () => {
  const directory = await temporaryDirectory();
  const logPath = join(directory, 'run.log');

  await saveCheckRecord(logPath, identity, false);

  expect(await readCheckRecord(recordPathFor(logPath))).toEqual({
    status: 'valid',
    record: { version: 2, ...identity, passed: false },
  });
});

it('reads a version 1 record as malformed so it is never reused', async () => {
  expect(await readCheckRecord(fixturePath('v1.json').pathname)).toEqual({ status: 'malformed' });
});

it('reads a record with no base commit', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'null.json');

  await writeFile(path, JSON.stringify({ version: 2, ...identity, passed: true, base: null }));

  expect(await readCheckRecord(path)).toEqual({
    status: 'valid',
    record: { version: 2, ...identity, passed: true, base: null },
  });
});

it('refuses to save a state without a fingerprint and writes no record', async () => {
  const directory = await temporaryDirectory();
  const logPath = join(directory, 'run.log');

  await expect(saveCheckRecord(logPath, { ...identity, fingerprint: null }, true)).rejects.toThrow(
    'submodule',
  );

  expect(await readCheckRecord(recordPathFor(logPath))).toEqual({ status: 'missing' });
});

it('leaves no temporary file when the record cannot replace its path', async () => {
  const directory = await temporaryDirectory();
  const logPath = join(directory, 'run.log');

  await mkdir(recordPathFor(logPath));

  await expect(saveCheckRecord(logPath, identity, true)).rejects.toThrow(
    /EISDIR|ENOTEMPTY|EEXIST|EPERM/u,
  );

  expect(await readdir(directory)).toEqual(['run.json']);
});
