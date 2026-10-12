import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
