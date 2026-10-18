import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { listSavedLogs, readCheckRecord, recordPathFor, saveCheckRecord } from './record.js';

const fixturePath = (name: string) => new URL(`fixtures/checkRecords/${name}`, import.meta.url);

const identity = {
  head: '1111111111111111111111111111111111111111',
  base: '2222222222222222222222222222222222222222',
  argv: ['pnpm', 'check'],
  fingerprint: '3333333333333333333333333333333333333333333333333333333333333333',
};

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-check-record-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

it('reads the current record fixture and a record it saved', async () => {
  const directory = await temporaryDirectory();
  const logPath = join(directory, 'run.log');

  await saveCheckRecord(logPath, identity);

  expect(await readCheckRecord(fixturePath('current.json').pathname)).toEqual({
    status: 'valid',
    record: { version: 1, ...identity },
  });

  expect(await readCheckRecord(recordPathFor(logPath))).toEqual({
    status: 'valid',
    record: { version: 1, ...identity },
  });

  expect(JSON.parse(await readFile(fixturePath('current.json'), 'utf8'))).toEqual({
    version: 1,
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
  const newer = join(directory, 'newer.json');

  await writeFile(notJson, '{ broken');
  await writeFile(newer, JSON.stringify({ version: 2, ...identity }));

  expect(await readCheckRecord(fixturePath('malformed.json').pathname)).toEqual({
    status: 'malformed',
  });

  expect(await readCheckRecord(notJson)).toEqual({ status: 'malformed' });
  expect(await readCheckRecord(newer)).toEqual({ status: 'malformed' });
});

it('lists logs newest first and keeps a malformed record from hiding the others', async () => {
  const directory = await temporaryDirectory();
  const checks = join(directory, 'checks');
  await mkdir(checks);

  await writeFile(join(checks, 'a.log'), 'old');
  await saveCheckRecord(join(checks, 'a.log'), identity);
  await writeFile(join(checks, 'b.log'), 'bad');
  await writeFile(join(checks, 'b.json'), '{ broken');
  await writeFile(join(checks, 'c.json'), JSON.stringify({ version: 1, ...identity }));

  expect(await listSavedLogs(checks)).toEqual([
    { logPath: join(checks, 'c.log'), record: { version: 1, ...identity }, logExists: false },
    { logPath: join(checks, 'b.log'), record: undefined, logExists: true },
    { logPath: join(checks, 'a.log'), record: { version: 1, ...identity }, logExists: true },
  ]);
});

it('lists no logs when the checks directory is missing', async () => {
  const directory = await temporaryDirectory();

  expect(await listSavedLogs(join(directory, 'checks'))).toEqual([]);
});

it('reports a record with an extra field as malformed', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'extra.json');

  await writeFile(path, JSON.stringify({ version: 1, ...identity, extra: true }));

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

  await writeFile(join(directory, 'loop.json'), JSON.stringify({ version: 1, ...identity }));
  await symlink('loop.log', join(directory, 'loop.log'));

  await expect(listSavedLogs(directory)).rejects.toMatchObject({ code: 'ELOOP' });
});

it('keeps a directory name that ends in .log out of the record path', async () => {
  const directory = await temporaryDirectory();
  const logDirectory = join(directory, 'checks.log');
  const logPath = join(logDirectory, 'run.log');

  await mkdir(logDirectory);
  await writeFile(logPath, 'output');
  await saveCheckRecord(logPath, identity);

  expect(recordPathFor(logPath)).toBe(join(logDirectory, 'run.json'));

  expect(await listSavedLogs(logDirectory)).toEqual([
    { logPath, record: { version: 1, ...identity }, logExists: true },
  ]);
});

it('keeps a directory name that ends in .json out of the log path', async () => {
  const directory = await temporaryDirectory();
  const checks = join(directory, 'checks.json');

  await mkdir(checks);
  await writeFile(join(checks, 'run.log'), 'output');
  await saveCheckRecord(join(checks, 'run.log'), identity);

  expect(await listSavedLogs(checks)).toEqual([
    { logPath: join(checks, 'run.log'), record: { version: 1, ...identity }, logExists: true },
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

  await writeFile(path, JSON.stringify({ version: 1, ...identity, ...change }));

  expect(await readCheckRecord(path)).toEqual({ status: 'malformed' });
});

it('reads a record with no base commit', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'null.json');

  await writeFile(path, JSON.stringify({ version: 1, ...identity, base: null }));

  expect(await readCheckRecord(path)).toEqual({
    status: 'valid',
    record: { version: 1, ...identity, base: null },
  });
});

it('refuses to save a state without a fingerprint and writes no record', async () => {
  const directory = await temporaryDirectory();
  const logPath = join(directory, 'run.log');

  await expect(saveCheckRecord(logPath, { ...identity, fingerprint: null })).rejects.toThrow(
    'submodule',
  );

  expect(await readCheckRecord(recordPathFor(logPath))).toEqual({ status: 'missing' });
});
