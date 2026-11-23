import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import {
  architectRecordPath,
  askRecordDirectory,
  gateRecordDirectory,
  askRecordPath,
  readArchitectRecord,
  readAskRecord,
  readAskRecordAt,
  readAskRecords,
  readGateRecord,
  changeAskRecord,
  isOpenLiveAsk,
  readOpenLiveAsks,
  writeArchitectRecord,
  writeAskRecord,
  writeAskRecordAt,
  writeGateRecord,
} from './record.js';
import type { LiveAskRecord } from './record.js';

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const copyFixture = async (name: string, path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await copyFile(fixturePath(name), path);
};

const withoutGateRecord = <Ask extends { gateRecord: unknown }>(
  ask: Ask,
): Omit<Ask, 'gateRecord'> => {
  const { gateRecord: _gateRecord, ...fields } = ask;

  return fields;
};

const snapshotDirectory = async (path: string): Promise<Record<string, string>> => {
  const names = await readdir(path).catch(() => []);

  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(join(path, name), 'utf8')] as const),
  );

  return Object.fromEntries(entries);
};

const architectRecordV1 = {
  version: 1,
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-architect',
  leadTerminal: 't-lead',
  updatedAt: '2026-11-17T10:00:00.000Z',
} as const;

const architectRecordV2 = {
  version: 2,
  sessionFile: '/sessions/architect.jsonl',
  leadTerminal: 't-lead',
  owner: {
    lockToken: 'lock-token',
    mode: 'visible',
    terminal: 't-architect',
    sessionId: 'session-architect',
  },
  updatedAt: '2026-11-17T10:00:00.000Z',
} as const;

const askRecordV1AsHidden = {
  version: 3,
  route: 'hidden',
  askId: '0190c1d2-0000-7000-8000-000000000101',
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1900000000000,
  status: 'sent',
  detail: null,
  answer: 'Use --quick.',
  gateRecord: null,
} as const;

const askRecordHidden = {
  version: 3,
  route: 'hidden',
  askId: '0190c1d2-0000-7000-8000-000000000102',
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1900000000000,
  status: 'running',
  detail: null,
  answer: null,
  gateRecord: null,
} as const;

const askRecordLive = {
  version: 3,
  route: 'live',
  askId: '0190c1d2-0000-7000-8000-000000000103',
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name?',
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  architectTerminal: 't-architect',
  architectSessionId: 'session-architect',
  architectLockToken: 'lock-architect',
  status: 'queued',
  detail: null,
  answer: null,
  gateRecord: null,
} as const;

it('reads a version 1 architect fixture as a version 1 record', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await copyFixture('architect-record-v1.json', architectRecordPath(root));

  expect(await readArchitectRecord(root)).toEqual(architectRecordV1);
});

it('reads a version 2 architect fixture as saved', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await copyFixture('architect-record-v2.json', architectRecordPath(root));

  expect(await readArchitectRecord(root)).toEqual(architectRecordV2);
});

it('reads a missing architect record as undefined', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  expect(await readArchitectRecord(root)).toBeUndefined();
});

it('refuses a malformed architect record', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = architectRecordPath(root);

  await copyFixture('architect-record-malformed.json', path);

  await expect(readArchitectRecord(root)).rejects.toThrow(`Malformed architect record ${path}`);
});

it('refuses a version 2 architect record with an unknown field', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = architectRecordPath(root);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...architectRecordV2, extra: true }));

  await expect(readArchitectRecord(root)).rejects.toThrow(`Malformed architect record ${path}`);
});

it('writes a version 2 architect record and reads it back', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeArchitectRecord(root, architectRecordV2);

  expect(await readArchitectRecord(root)).toEqual(architectRecordV2);
});

const gateRecord = {
  version: 1,
  createdAt: '2026-11-17T10:00:00.000Z',
  request: 'Rename the flag.',
  restatement: 'Rename --fast to --quick.',
  outcome: { kind: 'answered', label: 'specified', confidence: 0.9 },
  decision: 'specified',
  label: 'specified',
  confidence: 0.9,
} as const;

it('writes one gate record per call and reads it back', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const first = await writeGateRecord(root, gateRecord);
  const second = await writeGateRecord(root, gateRecord);

  expect(first).not.toBe(second);

  expect(await readGateRecord(root, first)).toEqual({
    kind: 'found',
    path: first,
    record: gateRecord,
  });

  expect(await readGateRecord(root, second)).toEqual({
    kind: 'found',
    path: second,
    record: gateRecord,
  });
});

it('reads a gate record from a checkout-relative reference', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = await writeGateRecord(root, gateRecord);
  const reference = join('.tau', 'lead', 'gate', basename(path));

  expect(await readGateRecord(root, reference)).toEqual({
    kind: 'found',
    path,
    record: gateRecord,
  });
});

it('returns an outside read for a path outside the gate directory', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = gateRecordDirectory(root);
  const path = join(root, 'gate.json');

  expect(await readGateRecord(root, path)).toEqual({ kind: 'outside', directory });
});

it('returns a missing read for a gate record path that does not exist', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(gateRecordDirectory(root), 'missing.json');

  await expect(readGateRecord(root, path)).resolves.toEqual({ kind: 'missing' });
});

it('returns an unreadable read for a malformed gate record at a path', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(gateRecordDirectory(root), 'malformed.json');

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{"version":1');

  await expect(readGateRecord(root, path)).resolves.toEqual({
    kind: 'unreadable',
    message: `Malformed gate record ${path}: not JSON.`,
  });
});

const notRegularFileMessage = (path: string): string =>
  `Gate record ${path} is not a regular file.`;

const createFifo = async (path: string): Promise<void> => {
  await promisify(execFile)('mkfifo', [path]);
};

const recordHandleReads = async (directory: string): Promise<MockInstance> => {
  const probePath = join(directory, 'probe.json');

  await writeFile(probePath, '{}');

  const probe = await open(probePath);
  const prototype = Object.getPrototypeOf(probe) as FileHandle;

  await probe.close();

  const read = vi.spyOn(prototype, 'readFile');

  onTestFinished(() => {
    read.mockRestore();
  });

  return read;
};

it('refuses a gate record reached through a linked parent directory', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-gate-record-');
  const directory = gateRecordDirectory(root);
  const outside = temporaryDirectory(onTestFinished, 'tau-gate-record-target-');
  const path = join(directory, 'linked', 'record.json');

  await mkdir(directory, { recursive: true });
  await writeFile(join(outside, 'record.json'), JSON.stringify(gateRecord));
  await symlink(outside, join(directory, 'linked'));

  const read = await recordHandleReads(root);

  await expect(readGateRecord(root, path)).resolves.toEqual({ kind: 'outside', directory });

  expect(read).not.toHaveBeenCalled();
});

it('refuses a gate record path that is a symbolic link', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-gate-record-');
  const directory = gateRecordDirectory(root);
  const target = join(directory, 'target.json');
  const path = join(directory, 'linked.json');

  await mkdir(directory, { recursive: true });
  await writeFile(target, JSON.stringify(gateRecord));
  await symlink(target, path);

  const read = await recordHandleReads(root);

  await expect(readGateRecord(root, path)).resolves.toEqual({
    kind: 'unreadable',
    message: notRegularFileMessage(path),
  });

  expect(read).not.toHaveBeenCalled();
});

it('refuses a gate record path that is a FIFO', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-gate-record-');
  const path = join(gateRecordDirectory(root), 'pipe.json');

  await mkdir(dirname(path), { recursive: true });
  await createFifo(path);

  const read = await recordHandleReads(root);

  await expect(readGateRecord(root, path)).resolves.toEqual({
    kind: 'unreadable',
    message: notRegularFileMessage(path),
  });

  expect(read).not.toHaveBeenCalled();
});

it('refuses a gate record path that is a directory', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-gate-record-');
  const path = join(gateRecordDirectory(root), 'directory.json');

  await mkdir(path, { recursive: true });

  const read = await recordHandleReads(root);

  await expect(readGateRecord(root, path)).resolves.toEqual({
    kind: 'unreadable',
    message: notRegularFileMessage(path),
  });

  expect(read).not.toHaveBeenCalled();
});

it('refuses a gate directory that is a link outside the checkout', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-gate-record-');
  const directory = gateRecordDirectory(root);
  const outside = temporaryDirectory(onTestFinished, 'tau-gate-record-target-');
  const path = join(directory, 'record.json');

  await mkdir(dirname(directory), { recursive: true });
  await writeFile(join(outside, 'record.json'), JSON.stringify(gateRecord));
  await symlink(outside, directory);

  const read = await recordHandleReads(root);

  await expect(readGateRecord(root, path)).resolves.toEqual({ kind: 'outside', directory });

  expect(read).not.toHaveBeenCalled();
});

it('refuses a dangling gate record link', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-gate-record-');
  const directory = gateRecordDirectory(root);
  const path = join(directory, 'linked.json');

  await mkdir(directory, { recursive: true });
  await symlink(join(directory, 'absent.json'), path);

  const read = await recordHandleReads(root);

  await expect(readGateRecord(root, path)).resolves.toEqual({
    kind: 'unreadable',
    message: notRegularFileMessage(path),
  });

  expect(read).not.toHaveBeenCalled();
});

it('returns a missing read for a record absent from an existing gate directory', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-gate-record-');
  const path = join(gateRecordDirectory(root), 'missing.json');

  await mkdir(gateRecordDirectory(root), { recursive: true });

  await expect(readGateRecord(root, path)).resolves.toEqual({ kind: 'missing' });
});

it('leaves gate records unchanged after normal, missing, and malformed reads', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = gateRecordDirectory(root);
  const normal = await writeGateRecord(root, gateRecord);
  const missing = join(directory, 'missing.json');
  const malformed = join(directory, 'malformed.json');

  await writeFile(malformed, '{"version":1');

  const before = await snapshotDirectory(directory);

  await readGateRecord(root, normal);
  await readGateRecord(root, missing);
  await readGateRecord(root, malformed);

  expect(await snapshotDirectory(directory)).toEqual(before);
});

it('reads a version 1 ask fixture as a hidden version 3 record without a gate record', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(root, '0190c1d2-0000-7000-8000-000000000101.json');

  await copyFixture('ask-record-v1.json', path);

  expect(await readAskRecordAt(path)).toEqual(askRecordV1AsHidden);
});

it('drops unknown fields from a version 1 ask', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(root, '0190c1d2-0000-7000-8000-000000000101.json');
  const v1 = { ...askRecordV1AsHidden, version: 1, extra: 'unknown' };

  await writeFile(path, JSON.stringify(v1));

  const record = await readAskRecordAt(path);

  expect(record).toEqual(askRecordV1AsHidden);

  await writeAskRecordAt(path, record as NonNullable<typeof record>);

  expect(await readAskRecordAt(path)).toEqual(askRecordV1AsHidden);
});

it('reads a version 2 hidden ask record as version 3 without a gate record', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(root, '0190c1d2-0000-7000-8000-000000000102.json');

  await copyFixture('ask-record-v2-hidden.json', path);

  expect(await readAskRecordAt(path)).toEqual(askRecordHidden);
});

it('reads a version 2 live ask record as version 3 without a gate record', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(root, '0190c1d2-0000-7000-8000-000000000103.json');

  await copyFixture('ask-record-v2-live.json', path);

  expect(await readAskRecordAt(path)).toEqual(askRecordLive);
});

it('round-trips a version 3 ask record with a gate record', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const record = {
    ...askRecordLive,
    askId: '0190c1d2-0000-7000-8000-000000000104',
    gateRecord: '/checkout/.tau/lead/gate/0190c1d2-0000-7000-8000-000000000901.json',
  };

  await writeAskRecord(root, record);

  expect(await readAskRecord(root, record.askId)).toEqual(record);
});

it('round-trips a version 3 hidden ask record with a gate record', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const record = {
    ...askRecordHidden,
    askId: '0190c1d2-0000-7000-8000-000000000110',
    gateRecord: '/checkout/.tau/lead/gate/0190c1d2-0000-7000-8000-000000000903.json',
  };

  await writeAskRecord(root, record);

  expect(await readAskRecord(root, record.askId)).toEqual(record);
});

it.for([
  ['hidden', askRecordHidden, 'missing'],
  ['hidden', askRecordHidden, 'invalid'],
  ['live', askRecordLive, 'missing'],
  ['live', askRecordLive, 'invalid'],
] as const)('refuses a version 3 %s ask whose gateRecord is %s', async ([, seed, problem]) => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = askRecordPath(root, seed.askId);
  const saved = problem === 'missing' ? withoutGateRecord(seed) : { ...seed, gateRecord: 42 };

  await mkdir(askRecordDirectory(root), { recursive: true });
  await writeFile(path, JSON.stringify(saved));

  await expect(readAskRecordAt(path)).rejects.toThrow(`Malformed ask record ${path}`);
});

it('reads the version 3 ask fixtures', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const hidden = askRecordPath(root, '0190c1d2-0000-7000-8000-000000000108');
  const live = askRecordPath(root, '0190c1d2-0000-7000-8000-000000000109');

  await copyFixture('ask-record-v3-hidden.json', hidden);
  await copyFixture('ask-record-v3-live.json', live);

  expect(await readAskRecordAt(hidden)).toEqual({
    ...askRecordHidden,
    askId: '0190c1d2-0000-7000-8000-000000000108',
  });

  expect(await readAskRecordAt(live)).toEqual({
    ...askRecordLive,
    askId: '0190c1d2-0000-7000-8000-000000000109',
    gateRecord: '/checkout/.tau/lead/gate/0190c1d2-0000-7000-8000-000000000902.json',
  });
});

it.for([
  [
    'an askId that is not a UUID under another name',
    'not-a-uuid',
    '0190c1d2-0000-7000-8000-000000000703',
  ],
  [
    'an askId that does not match its file name',
    '0190c1d2-0000-7000-8000-000000000702',
    '0190c1d2-0000-7000-8000-000000000703',
  ],
  ['an askId that is not a UUID under its own name', 'not-a-uuid', 'not-a-uuid'],
] as const)('refuses a saved ask with %s', async ([, savedAskId, askId]) => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = askRecordPath(root, askId);

  await mkdir(askRecordDirectory(root), { recursive: true });
  await writeFile(path, JSON.stringify({ ...askRecordLive, askId: savedAskId }));

  await expect(readAskRecord(root, askId)).rejects.toThrow(`Malformed ask record ${path}`);
});

it.for(['answered', 'failed'] as const)(
  'serializes changes to one ask so %s is never reopened',
  async (status) => {
    const root = await createTemporaryRepository(onTestFinished);
    const askId = '0190c1d2-0000-7000-8000-000000000704';

    await writeAskRecord(root, { ...askRecordLive, askId, status: 'unknown' });

    const read = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();

    const first = changeAskRecord(
      root,
      askId,
      (current) => (current.route === 'live' ? { ...current, status: 'queued' } : undefined),
      {
        afterRead: async () => {
          read.resolve(undefined);
          await release.promise;
        },
      },
    );

    await read.promise;

    const waiting = Promise.withResolvers<undefined>();

    const second = changeAskRecord(
      root,
      askId,
      (current) =>
        isOpenLiveAsk(current) ? { ...current, status, answer: 'Use --dry-run.' } : undefined,
      {
        onWaiting: () => {
          waiting.resolve(undefined);
        },
      },
    );

    const outcome = await Promise.race([
      waiting.promise.then(() => 'waiting'),
      second.then(() => 'done'),
    ]);

    expect(outcome).toBe('waiting');

    release.resolve(undefined);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult?.changed).toBe(true);
    expect(secondResult?.changed).toBe(true);
    expect(await readAskRecord(root, askId)).toMatchObject({ status });
  },
);

it('reads a missing ask record as undefined', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  expect(await readAskRecord(root, 'missing')).toBeUndefined();
});

it('refuses a malformed ask record', async () => {
  const path = fixturePath('ask-record-malformed.json');

  await expect(readAskRecordAt(path)).rejects.toThrow(`Malformed ask record ${path}`);
});

it('refuses a version 3 live ask with an unknown field', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(root, '0190c1d2-0000-7000-8000-000000000103.json');

  await writeFile(path, JSON.stringify({ ...askRecordLive, extra: true }));

  await expect(readAskRecordAt(path)).rejects.toThrow(`Malformed ask record ${path}`);
});

it('refuses a version 3 hidden ask with an unknown field', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(root, '0190c1d2-0000-7000-8000-000000000102.json');

  await writeFile(path, JSON.stringify({ ...askRecordHidden, extra: true }));

  await expect(readAskRecordAt(path)).rejects.toThrow(`Malformed ask record ${path}`);
});

it('refuses a version 2 live ask with an unknown field', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(root, '0190c1d2-0000-7000-8000-000000000103.json');
  const saved = { ...withoutGateRecord(askRecordLive), version: 2 };

  await writeFile(path, JSON.stringify({ ...saved, extra: true }));

  await expect(readAskRecordAt(path)).rejects.toThrow(`Malformed ask record ${path}`);
});

it('refuses a version 2 hidden ask with an unknown field', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = join(root, '0190c1d2-0000-7000-8000-000000000102.json');
  const saved = { ...withoutGateRecord(askRecordHidden), version: 2 };

  await writeFile(path, JSON.stringify({ ...saved, extra: true }));

  await expect(readAskRecordAt(path)).rejects.toThrow(`Malformed ask record ${path}`);
});

it('lists ask records oldest first and reads one by id', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const later = {
    ...askRecordHidden,
    askId: '0190c1d2-0000-7000-8000-000000000105',
    createdAt: '2026-11-17T10:00:01.000Z',
  } as const;

  const earlier = {
    ...askRecordHidden,
    askId: '0190c1d2-0000-7000-8000-000000000104',
    createdAt: '2026-11-17T10:00:00.000Z',
  } as const;

  await writeAskRecord(root, later);
  await writeAskRecord(root, earlier);

  expect((await readAskRecords(root)).records.map((record) => record.askId)).toEqual([
    '0190c1d2-0000-7000-8000-000000000104',
    '0190c1d2-0000-7000-8000-000000000105',
  ]);

  expect(await readAskRecord(root, '0190c1d2-0000-7000-8000-000000000105')).toEqual(later);
  expect(await readAskRecord(root, 'missing')).toBeUndefined();
});

it('keeps valid asks beside a malformed and newer file', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAskRecord(root, askRecordHidden);
  await mkdir(askRecordDirectory(root), { recursive: true });

  const malformed = join(askRecordDirectory(root), 'malformed.json');
  const newerId = '0190c1d2-0000-7000-8000-000000000998';
  const newer = join(askRecordDirectory(root), `${newerId}.json`);

  await writeFile(malformed, '{"version":2,"route":"live"}');
  await writeFile(newer, JSON.stringify({ ...askRecordLive, askId: newerId, version: 4 }));

  const { records, gaps } = await readAskRecords(root);

  expect(records.map((record) => record.askId)).toEqual(['0190c1d2-0000-7000-8000-000000000102']);

  const reasons = new Map(gaps.map((gap) => [basename(gap.path), gap.reason]));

  expect([...reasons.keys()].toSorted()).toEqual([`${newerId}.json`, 'malformed.json']);

  expect(reasons.get(`${newerId}.json`)).toBe(
    `Ask record ${newer} has a newer format than this Tau reads. Update Tau, then restart the session.`,
  );

  expect(reasons.get('malformed.json')).toContain(`Malformed ask record ${malformed}`);
});

it('skips a listed ask file that disappeared', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAskRecord(root, askRecordHidden);

  await symlink(
    join(askRecordDirectory(root), 'missing.json'),
    join(askRecordDirectory(root), 'gone.json'),
  );

  const { records, gaps } = await readAskRecords(root);

  expect(records.map((record) => record.askId)).toEqual(['0190c1d2-0000-7000-8000-000000000102']);
  expect(gaps).toEqual([]);
});

it('lists no ask records before the directory exists', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  expect(await readAskRecords(root)).toEqual({ records: [], gaps: [] });
});

const liveIds = {
  closed: '0190c1d2-0000-7000-8000-000000000201',
  queued: '0190c1d2-0000-7000-8000-000000000202',
  other: '0190c1d2-0000-7000-8000-000000000203',
  sending: '0190c1d2-0000-7000-8000-000000000204',
  unknown: '0190c1d2-0000-7000-8000-000000000205',
  failed: '0190c1d2-0000-7000-8000-000000000206',
} as const;

const liveAsk = (
  name: keyof typeof liveIds,
  createdAt: string,
  status: LiveAskRecord['status'],
  architectSessionId = 'session-architect',
): LiveAskRecord => ({
  version: 3,
  route: 'live',
  askId: liveIds[name],
  createdAt,
  question: `Question ${name}?`,
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  architectTerminal: 't-architect',
  architectSessionId,
  architectLockToken: 'live',
  status,
  detail: null,
  answer: null,
  gateRecord: null,
});

it('lists open live asks for one architect session oldest first', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAskRecord(root, liveAsk('closed', '2026-11-17T10:00:00.000Z', 'answered'));
  await writeAskRecord(root, liveAsk('queued', '2026-11-17T10:00:02.000Z', 'queued'));
  await writeAskRecord(root, liveAsk('other', '2026-11-17T10:00:01.000Z', 'queued', 'other'));
  await writeAskRecord(root, liveAsk('sending', '2026-11-17T10:00:01.000Z', 'sending'));
  await writeAskRecord(root, liveAsk('unknown', '2026-11-17T10:00:03.000Z', 'unknown'));
  await writeAskRecord(root, liveAsk('failed', '2026-11-17T10:00:04.000Z', 'failed'));
  await writeAskRecord(root, askRecordHidden);

  const before = await snapshotDirectory(askRecordDirectory(root));

  expect((await readOpenLiveAsks(root, 'session-architect')).map((record) => record.askId)).toEqual(
    [liveIds.sending, liveIds.queued, liveIds.unknown],
  );

  expect(await snapshotDirectory(askRecordDirectory(root))).toEqual(before);
});

it('lists no open live asks before the directory exists', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  expect(await readOpenLiveAsks(root, 'session-architect')).toEqual([]);
  expect(existsSync(askRecordDirectory(root))).toBe(false);
});

it('lists open live asks beside a malformed file', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAskRecord(root, liveAsk('queued', '2026-11-17T10:00:02.000Z', 'queued'));
  await writeFile(join(askRecordDirectory(root), 'malformed.json'), '{"version":2');

  const before = await snapshotDirectory(askRecordDirectory(root));

  expect((await readOpenLiveAsks(root, 'session-architect')).map((record) => record.askId)).toEqual(
    [liveIds.queued],
  );

  expect(await snapshotDirectory(askRecordDirectory(root))).toEqual(before);
});

it('returns undefined when the ask record disappears before its change', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const askId = '0190c1d2-0000-7000-8000-000000000705';

  await expect(
    changeAskRecord(root, askId, (current) => ({ ...current, status: 'failed' })),
  ).resolves.toBeUndefined();

  await expect(readAskRecord(root, askId)).resolves.toBeUndefined();
});

it('returns changed false and leaves the record when the change declines', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const askId = '0190c1d2-0000-7000-8000-000000000706';
  const record = { ...askRecordLive, askId, status: 'answered' as const };

  await writeAskRecord(root, record);

  const result = await changeAskRecord(root, askId, () => undefined);

  expect(result).toMatchObject({ changed: false, record });
  expect(await readAskRecord(root, askId)).toEqual(record);
});
