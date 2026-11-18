import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { isItemName, isRunName } from './records.js';
import type { ItemRecord, RunRecord, Step } from './records.js';
import {
  itemRecordPath,
  readItemRecord,
  readRuns,
  readRunRecord,
  runDirectoryPath,
  runRecordPath,
  validateItemRecord,
} from './verification.js';

const fixturePath = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

const containing = (text: string): unknown => expect.stringContaining(text);

const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);

const validRunRecord: RunRecord = {
  version: 1,
  run: 'delegate-a-check',
  target: '482',
  head: '1111111111111111111111111111111111111111',
  dirty: false,
  platform: { os: 'linux', arch: 'x64' },
  startedAt: '2026-11-16T10:00:00.000Z',
  treeAtLaunch: '2222222222222222222222222222222222222222',
  treeAtStop: '3333333333333333333333333333333333333333',
  launch: { exitCode: 0, logPath: 'launch.log' },
  doctor: { exitCode: 0, logPath: 'doctor.log' },
  stop: { exitCode: 0, logPath: 'stop.log' },
  items: [{ item: 'journeys/delegate-a-check', steps: 2 }],
};

const passedStep: Step = {
  number: 1,
  status: 'passed',
  artifacts: [{ kind: 'screenshot', path: 'screenshots/step-1.png' }],
};

const differsStep: Step = {
  number: 2,
  status: 'differs',
  observed: 'The dialog stays open.',
  artifacts: [{ kind: 'output', path: 'output/step-2.txt' }],
};

const validItemRecord: ItemRecord = {
  version: 1,
  run: 'delegate-a-check',
  item: 'journeys/delegate-a-check',
  drive: 'hand',
  steps: [passedStep, differsStep],
  endState: { status: 'passed' },
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};

const setupRun = async (
  verificationDirectory: string,
  run: string,
  items: { item: string; steps: number }[],
): Promise<string> => {
  const directory = join(verificationDirectory, run);

  await writeJson(runRecordPath(directory), { ...validRunRecord, run, items });

  return directory;
};

const snapshotFiles = async (directory: string): Promise<Record<string, string>> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());

  const contents = await Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      const text = await readFile(path, 'utf8');

      return [relative(directory, path), text] as const;
    }),
  );

  return Object.fromEntries(contents);
};

it('reads a valid run record fixture', async () => {
  expect(await readRunRecord(fixturePath('run.json'))).toEqual({
    status: 'valid',
    record: validRunRecord,
  });
});

it('reads a valid item record fixture', async () => {
  expect(await readItemRecord(fixturePath('item.json'))).toEqual({
    status: 'valid',
    record: validItemRecord,
  });
});

it('reports a missing run record and item record as missing', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');

  expect(await readRunRecord(join(directory, 'run.json'))).toEqual({ status: 'missing' });
  expect(await readItemRecord(join(directory, 'item.json'))).toEqual({ status: 'missing' });
});

it('reports malformed run records', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const paths: string[] = [fixturePath('runMalformed.json')];

  const notJson = join(directory, 'not-json.json');
  await writeFile(notJson, '{ broken');
  paths.push(notJson);

  const extra = join(directory, 'extra.json');
  await writeJson(extra, { ...validRunRecord, extra: true });
  paths.push(extra);

  const nonCanonical = join(directory, 'non-canonical.json');
  await writeJson(nonCanonical, { ...validRunRecord, startedAt: '2026-11-16T10:00:00Z' });
  paths.push(nonCanonical);

  const duplicate = join(directory, 'duplicate.json');

  await writeJson(duplicate, {
    ...validRunRecord,
    items: [
      { item: 'journeys/delegate-a-check', steps: 1 },
      { item: 'journeys/delegate-a-check', steps: 2 },
    ],
  });

  paths.push(duplicate);

  for (const path of paths) {
    expect(await readRunRecord(path)).toMatchObject({
      status: 'malformed',
      problem: matching(/.+/u),
    });
  }

  const itemNameCollision = join(directory, 'item-name-collision.json');

  await writeJson(itemNameCollision, {
    ...validRunRecord,
    items: [{ item: 'checks/smoke.json/details', steps: 1 }],
  });

  const collision = await readRunRecord(itemNameCollision);

  expect(collision).toMatchObject({
    status: 'malformed',
    problem: containing('/items/0'),
  });

  const problemText = collision.status === 'malformed' ? collision.problem : '';
  expect(problemText).toContain('.json');
});

it('rejects registered item names that differ only in case', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const path = join(directory, 'case-duplicate.json');

  await writeJson(path, {
    ...validRunRecord,
    items: [
      { item: 'checks/smoke', steps: 1 },
      { item: 'checks/SMOKE', steps: 1 },
    ],
  });

  expect(await readRunRecord(path)).toMatchObject({
    status: 'malformed',
    problem: containing('/items/1'),
  });
});

it('rejects an item name with an earlier segment ending in .json in any case', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const path = join(directory, 'case-json-segment.json');

  await writeJson(path, {
    ...validRunRecord,
    items: [{ item: 'checks/smoke.JSON/details', steps: 1 }],
  });

  expect(await readRunRecord(path)).toMatchObject({
    status: 'malformed',
    problem: containing('/items/0'),
  });
});

it('reports malformed item records', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');

  const outOfOrder = join(directory, 'out-of-order.json');
  await writeJson(outOfOrder, { ...validItemRecord, steps: [{ ...passedStep, number: 2 }] });

  const parentSegment = join(directory, 'parent-segment.json');

  await writeJson(parentSegment, {
    ...validItemRecord,
    steps: [
      {
        number: 1,
        status: 'passed',
        artifacts: [{ kind: 'screenshot', path: 'screenshots/../step-1.png' }],
      },
    ],
  });

  const absolute = join(directory, 'absolute.json');

  await writeJson(absolute, {
    ...validItemRecord,
    steps: [
      {
        number: 1,
        status: 'passed',
        artifacts: [{ kind: 'screenshot', path: '/tmp/step-1.png' }],
      },
    ],
  });

  const missingObserved = join(directory, 'missing-observed.json');

  await writeJson(missingObserved, {
    ...validItemRecord,
    steps: [
      {
        number: 1,
        status: 'differs',
        artifacts: [],
      },
    ],
  });

  expect(await readItemRecord(fixturePath('itemMalformed.json'))).toMatchObject({
    status: 'malformed',
    problem: matching(/.+/u),
  });

  for (const path of [outOfOrder, parentSegment, absolute]) {
    expect(await readItemRecord(path)).toMatchObject({
      status: 'malformed',
      problem: matching(/.+/u),
    });
  }

  expect(await readItemRecord(missingObserved)).toMatchObject({
    status: 'malformed',
    problem: containing('observed'),
  });
});

it.each([
  {
    name: 'a backslash in an artifact path',
    steps: [
      {
        number: 1,
        status: 'passed',
        artifacts: [{ kind: 'screenshot', path: 'screenshots\\step-1.png' }],
      },
    ],
    endState: { status: 'passed' },
    expected: ['/steps/0/artifacts/0'],
  },
  {
    name: 'an empty artifact path segment',
    steps: [
      {
        number: 1,
        status: 'passed',
        artifacts: [{ kind: 'screenshot', path: 'screenshots//step-1.png' }],
      },
    ],
    endState: { status: 'passed' },
    expected: ['/steps/0/artifacts/0'],
  },
  {
    name: 'a dot artifact path segment',
    steps: [
      {
        number: 1,
        status: 'passed',
        artifacts: [{ kind: 'screenshot', path: 'screenshots/./step-1.png' }],
      },
    ],
    endState: { status: 'passed' },
    expected: ['/steps/0/artifacts/0'],
  },
  {
    name: 'an extra step variant field',
    steps: [{ ...passedStep, observed: 'unexpected' }],
    endState: { status: 'passed' },
    expected: ['/steps/0', 'observed'],
  },
  {
    name: 'a malformed endState',
    steps: [passedStep],
    endState: { status: 'differs' },
    expected: ['/endState', 'observed'],
  },
])('rejects an item record with $name', async ({ steps, endState, expected }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const path = join(directory, 'item.json');

  await writeJson(path, { ...validItemRecord, steps, endState });

  const read = await readItemRecord(path);

  expect(read.status).toBe('malformed');

  const problem = read.status === 'malformed' ? read.problem : '';

  for (const text of expected) {
    expect(problem).toContain(text);
  }
});

it('reports a newer run record and item record as malformed with the update notice', async () => {
  expect(await readRunRecord(fixturePath('runV2.json'))).toMatchObject({
    status: 'malformed',
    problem: containing('newer format'),
  });

  expect(await readItemRecord(fixturePath('itemV2.json'))).toMatchObject({
    status: 'malformed',
    problem: containing('newer format'),
  });
});

it('reads every run directory with its registered items', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const runs = join(directory, 'runs');

  await cp(fixturePath('runs'), runs, { recursive: true });

  const result = await readRuns(runs);

  const summary = result.map(({ run, read, items }) => ({
    run,
    status: read.status,
    items: items.map(({ item, read: itemRead }) => ({ item, status: itemRead.status })),
  }));

  expect(summary).toEqual([
    {
      run: 'alpha',
      status: 'valid',
      items: [{ item: 'journeys/delegate-a-check', status: 'valid' }],
    },
    { run: 'beta', status: 'valid', items: [{ item: 'checks/smoke', status: 'valid' }] },
  ]);
});

it('reads an item whose name ends in .json from its doubled extension file', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const runs = join(directory, 'runs');

  const runDirectory = await setupRun(runs, 'json-item', [
    { item: 'reports/summary.json', steps: 1 },
  ]);

  await writeJson(itemRecordPath(runDirectory, 'reports/summary.json'), {
    ...validItemRecord,
    run: 'json-item',
    item: 'reports/summary.json',
    steps: [passedStep],
  });

  const [result] = await readRuns(runs);

  expect(result?.read.status).toBe('valid');

  expect(result?.items).toMatchObject([
    {
      item: 'reports/summary.json',
      path: join(runDirectory, 'items', 'reports', 'summary.json.json'),
      read: { status: 'valid' },
    },
  ]);
});

it('reports mixed run and item envelopes without changing saved records', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const runs = join(directory, 'runs');

  const validRun = await setupRun(runs, 'valid', [
    { item: 'journeys/present', steps: 2 },
    { item: 'journeys/missing', steps: 1 },
    { item: 'journeys/malformed', steps: 1 },
  ]);

  await writeJson(itemRecordPath(validRun, 'journeys/present'), {
    ...validItemRecord,
    run: 'valid',
    item: 'journeys/present',
  });

  await writeFile(itemRecordPath(validRun, 'journeys/malformed'), '{ broken');

  const retainedRun = await setupRun(runs, 'retained', [{ item: 'checks/retained', steps: 1 }]);

  await writeJson(itemRecordPath(retainedRun, 'checks/retained'), {
    ...validItemRecord,
    run: 'retained',
    item: 'checks/retained',
    steps: [passedStep],
  });

  await mkdir(join(runs, 'missing-run'), { recursive: true });

  const malformedRun = join(runs, 'malformed-run');

  await writeJson(runRecordPath(malformedRun), {
    ...validRunRecord,
    run: 'malformed-run',
    dirty: 'yes',
  });

  await writeJson(itemRecordPath(malformedRun, 'journeys/delegate-a-check'), {
    ...validItemRecord,
    run: 'malformed-run',
  });

  const newerRun = join(runs, 'newer-run');

  await writeJson(runRecordPath(newerRun), {
    ...validRunRecord,
    version: 2,
    run: 'newer-run',
  });

  await writeJson(itemRecordPath(newerRun, 'journeys/delegate-a-check'), {
    ...validItemRecord,
    run: 'newer-run',
  });

  const unreadableRun = join(runs, 'unreadable-run');

  await mkdir(runRecordPath(unreadableRun), { recursive: true });

  const before = await snapshotFiles(runs);
  const result = await readRuns(runs);
  const after = await snapshotFiles(runs);
  const byRun = Object.fromEntries(result.map((run) => [run.run, run]));

  expect(byRun['valid']?.read.status).toBe('valid');

  expect(byRun['valid']?.items.map(({ item, read }) => ({ item, status: read.status }))).toEqual([
    { item: 'journeys/present', status: 'valid' },
    { item: 'journeys/missing', status: 'missing' },
    { item: 'journeys/malformed', status: 'malformed' },
  ]);

  expect(byRun['valid']?.items[2]?.read).toMatchObject({
    status: 'malformed',
    problem: matching(/.+/u),
  });

  expect(byRun['retained']?.read.status).toBe('valid');
  expect(byRun['retained']?.items[0]?.read.status).toBe('valid');

  expect(byRun['missing-run']?.read).toEqual({ status: 'missing' });
  expect(byRun['missing-run']?.items).toEqual([]);

  expect(byRun['malformed-run']?.read).toMatchObject({
    status: 'malformed',
    problem: matching(/.+/u),
  });

  expect(byRun['malformed-run']?.items).toEqual([]);

  expect(byRun['newer-run']?.read).toMatchObject({
    status: 'malformed',
    problem: containing('newer format'),
  });

  expect(byRun['newer-run']?.items).toEqual([]);

  expect(byRun['unreadable-run']?.read).toMatchObject({
    status: 'malformed',
    problem: containing('EISDIR'),
  });

  expect(byRun['unreadable-run']?.items).toEqual([]);

  expect(after).toEqual(before);
});

it('reports an item file that does not match its run as malformed', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const registeredItem = { item: 'journeys/delegate-a-check', steps: 2 };
  const registered = [registeredItem];

  const runMismatch = await setupRun(join(directory, 'run-mismatch'), 'run-mismatch', registered);

  await writeJson(itemRecordPath(runMismatch, registeredItem.item), {
    ...validItemRecord,
    run: 'other-run',
  });

  const itemMismatch = await setupRun(
    join(directory, 'item-mismatch'),
    'item-mismatch',
    registered,
  );

  await writeJson(itemRecordPath(itemMismatch, registeredItem.item), {
    ...validItemRecord,
    run: 'item-mismatch',
    item: 'journeys/other-item',
  });

  const stepCount = await setupRun(join(directory, 'step-count'), 'step-count', registered);

  await writeJson(itemRecordPath(stepCount, registeredItem.item), {
    ...validItemRecord,
    run: 'step-count',
    steps: [passedStep],
  });

  const [runResult] = await readRuns(join(directory, 'run-mismatch'));
  const [itemResult] = await readRuns(join(directory, 'item-mismatch'));
  const [stepResult] = await readRuns(join(directory, 'step-count'));

  expect(runResult?.items[0]?.read).toMatchObject({
    status: 'malformed',
    problem: containing('/run'),
  });

  expect(itemResult?.items[0]?.read).toMatchObject({
    status: 'malformed',
    problem: containing('/item'),
  });

  expect(stepResult?.items[0]?.read).toMatchObject({
    status: 'malformed',
    problem: containing('/steps'),
  });
});

it('ignores a plain file in the verification directory', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');

  await setupRun(directory, 'run-a', [{ item: 'journeys/delegate-a-check', steps: 2 }]);
  await writeFile(join(directory, 'notes.txt'), 'not a run');

  const result = await readRuns(directory);

  expect(result.map(({ run }) => run)).toEqual(['run-a']);
});

it('lists no runs when the verification directory is missing', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');

  expect(await readRuns(join(directory, 'verification'))).toEqual([]);
});

it('reports a run whose name differs from its directory as malformed with no items', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');

  const runDirectory = await setupRun(directory, 'directory-name', [
    { item: 'journeys/delegate-a-check', steps: 2 },
  ]);

  await writeJson(itemRecordPath(runDirectory, 'journeys/delegate-a-check'), validItemRecord);

  const recordPath = runRecordPath(runDirectory);
  await writeJson(recordPath, { ...validRunRecord, run: 'other-name' });

  expect(await readRuns(directory)).toMatchObject([
    {
      run: 'directory-name',
      read: { status: 'malformed', problem: containing('/run') },
      items: [],
    },
  ]);
});

it('ignores an item file the run does not register', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const runs = join(directory, 'runs');

  await cp(fixturePath('runs'), runs, { recursive: true });

  await writeJson(join(runs, 'alpha', 'items', 'journeys', 'unregistered.json'), {
    ...validItemRecord,
    run: 'alpha',
    item: 'journeys/unregistered',
  });

  const [alpha] = await readRuns(runs);

  expect(alpha?.items).toHaveLength(1);
  expect(alpha?.items[0]?.item).toBe('journeys/delegate-a-check');
  expect(alpha?.items[0]?.read.status).toBe('valid');
});

it('reports an unreadable item as malformed while keeping its run and other items', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const runs = join(directory, 'runs');

  const runDirectory = await setupRun(runs, 'unreadable-item', [
    { item: 'journeys/present', steps: 1 },
    { item: 'journeys/unreadable', steps: 1 },
  ]);

  await writeJson(itemRecordPath(runDirectory, 'journeys/present'), {
    ...validItemRecord,
    run: 'unreadable-item',
    item: 'journeys/present',
    steps: [passedStep],
  });

  await mkdir(itemRecordPath(runDirectory, 'journeys/unreadable'), { recursive: true });

  const [result] = await readRuns(runs);

  expect(result?.read.status).toBe('valid');

  expect(result?.items.map(({ item, read }) => ({ item, status: read.status }))).toEqual([
    { item: 'journeys/present', status: 'valid' },
    { item: 'journeys/unreadable', status: 'malformed' },
  ]);

  expect(result?.items[1]?.read).toMatchObject({
    status: 'malformed',
    problem: containing('EISDIR'),
  });
});

it('reports a read error that is not a missing file as malformed', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');

  await mkdir(join(directory, 'run.json'));

  expect(await readRunRecord(join(directory, 'run.json'))).toMatchObject({
    status: 'malformed',
    problem: containing('EISDIR'),
  });
});

it('rejects a verification directory that is a plain file', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const path = join(directory, 'verification');

  await writeFile(path, 'not a directory');

  await expect(readRuns(path)).rejects.toMatchObject({ code: 'ENOTDIR' });
});

it.each([
  {
    name: 'a run name with a parent segment',
    record: { ...validRunRecord, run: '../x' },
    read: readRunRecord,
    expected: '/run',
  },
  {
    name: 'a registered item name with an empty segment',
    record: { ...validRunRecord, items: [{ item: 'a//b', steps: 1 }] },
    read: readRunRecord,
    expected: '/items/0/item',
  },
  {
    name: 'an item record name with an empty segment',
    record: { ...validItemRecord, item: 'a//b' },
    read: readItemRecord,
    expected: '/item',
  },
])('rejects $name', async ({ record, read, expected }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-');
  const path = join(directory, 'record.json');

  await writeJson(path, record);

  expect(await read(path)).toMatchObject({
    status: 'malformed',
    problem: containing(`: ${expected} must match pattern`),
  });
});

it('builds a run directory path below .tau/verification', () => {
  expect(runDirectoryPath('/repo', 'delegate-a-check')).toBe(
    join('/repo', '.tau', 'verification', 'delegate-a-check'),
  );
});

it('validates an item record with the reader rules', () => {
  expect(validateItemRecord('/run/items/item.json', validItemRecord)).toEqual(validItemRecord);

  expect(() =>
    validateItemRecord('/run/items/item.json', {
      ...validItemRecord,
      steps: [{ ...passedStep, number: 2 }],
    }),
  ).toThrow('Malformed item record');
});

it('recognizes run and item names', () => {
  expect([
    isRunName('delegate-a-check'),
    isRunName('../run'),
    isItemName('journeys/delegate-a-check'),
    isItemName('a//b'),
  ]).toEqual([true, false, true, false]);
});
