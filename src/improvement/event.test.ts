import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.ts';
import { parseEvent, readEvents, writeEvent } from './event.ts';
import type { ImprovementEvent } from './event.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const createProject = () => createTemporaryRepository((cleanup) => cleanups.push(cleanup));

const eventDirectory = (root: string) => join(root, '.tau', 'improvement');

const correction = (id: string, summary: string): ImprovementEvent => ({
  version: 1,
  id,
  kind: 'correction',
  createdAt: '2026-11-15T12:05:00.000Z',
  evidence: [{ kind: 'transcript', path: '/sessions/manager.jsonl', toolCallId: 'call-1' }],
  summary,
  cwd: '/code/tau',
});

const writeEventFile = async (root: string, name: string, text: string) => {
  await mkdir(eventDirectory(root), { recursive: true });
  const path = join(eventDirectory(root), name);
  await writeFile(path, text);

  return path;
};

describe('parseEvent', () => {
  it.each(['merge', 'facts', 'correction', 'review', 'decision', 'backlog'])(
    'parses the version 1 %s fixture',
    async (kind) => {
      const path = join(import.meta.dirname, 'fixtures', `event-v1-${kind}.json`);

      const event = parseEvent(path, await readFile(path, 'utf8'));

      expect({ version: event.version, kind: event.kind }).toEqual({ version: 1, kind });
    },
  );

  it('names the invalid field of a known kind', () => {
    const text = JSON.stringify({ ...correction('c-1', 'Use focused tests.'), cwd: 7 });

    expect(() => parseEvent('/events/c-1.json', text)).toThrow(/\/events\/c-1\.json: \/cwd /u);
  });

  it('refuses an unknown kind with an error naming its path', () => {
    const text = JSON.stringify({ ...correction('c-1', 'Use focused tests.'), kind: 'retired' });

    expect(() => parseEvent('/events/c-1.json', text)).toThrow('/events/c-1.json');
  });

  it('refuses JSON that is not an object with an error naming its path', () => {
    expect(() => parseEvent('/events/c-1.json', '[1]')).toThrow('/events/c-1.json');
  });

  it.each([
    { kind: 'transcript', path: '/sessions/manager.jsonl', toolCallId: 'call-1' },
    { kind: 'transcript', path: '/sessions/manager.jsonl', toolCallId: 'call-1', entryId: 'e-1' },
    { kind: 'session', sessionId: 'session-1', toolCallId: 'call-1' },
  ] as const)('round-trips the evidence pointer %j', async (pointer) => {
    const root = await createProject();
    const evidence = [pointer];
    const event = { ...correction('correction-1', 'Run focused tests first.'), evidence };

    await writeEvent(root, event);

    expect(await readEvents(root)).toEqual({ events: [event], gaps: [] });
  });
});

describe('readEvents', () => {
  it('returns the saved events', async () => {
    const root = await createProject();
    const first = correction('correction-1', 'Run focused tests first.');
    const second = correction('correction-2', 'Ask before deleting files.');
    await writeEvent(root, second);
    await writeEvent(root, first);

    expect(await readEvents(root)).toEqual({ events: [first, second], gaps: [] });
  });

  it('returns no events when .tau/improvement is missing', async () => {
    const root = await createProject();

    expect(await readEvents(root)).toEqual({ events: [], gaps: [] });
  });

  it('throws a read error other than a missing directory', async () => {
    const root = await createProject();
    await mkdir(join(root, '.tau'));
    await writeFile(eventDirectory(root), 'not a directory');

    await expect(readEvents(root)).rejects.toThrow('ENOTDIR');
  });

  it('ignores an unpublished receipt file', async () => {
    const root = await createProject();
    const event = correction('correction-1', 'Run focused tests first.');
    await writeEvent(root, event);
    await writeEventFile(root, '.receipt-0f6b', 'partial');

    expect(await readEvents(root)).toEqual({ events: [event], gaps: [] });
  });

  it('skips a malformed event file and lists it with its path and reason', async () => {
    const root = await createProject();
    await writeEvent(root, correction('correction-1', 'Run focused tests first.'));
    const path = await writeEventFile(root, 'broken.json', '{"version":1,');

    const { events, gaps } = await readEvents(root);

    expect(events.map((event) => event.id)).toEqual(['correction-1']);
    expect(gaps.map((gap) => gap.path)).toEqual([path]);
    expect(gaps[0]?.reason).toContain(path);
  });

  it('skips an event with a newer version and lists it with its path', async () => {
    const root = await createProject();
    const event = correction('correction-1', 'Run focused tests first.');
    const newer = { ...correction('correction-9', 'Later format.'), version: 2 };
    await writeEvent(root, event);
    const path = await writeEventFile(root, 'correction-9.json', JSON.stringify(newer));

    const { events, gaps } = await readEvents(root);

    const notices = gaps.map((entry) => entry.reason.includes('restart the session'));

    expect({ events, paths: gaps.map((entry) => entry.path), notices }).toEqual({
      events: [event],
      paths: [path],
      notices: [true],
    });
  });
});

describe('writeEvent', () => {
  it('refuses a write outside the test write root and creates nothing', async () => {
    const allowed = await createProject();
    const outside = await createProject();

    vi.stubEnv('TAU_TEST_WRITE_ROOT', allowed);

    await expect(writeEvent(outside, correction('correction-1', 'Escape.'))).rejects.toThrow(
      `outside the test write root ${allowed}`,
    );

    expect(existsSync(join(outside, '.tau'))).toBe(false);
  });

  it('keeps the first content when the same event ID is written twice', async () => {
    const root = await createProject();
    const first = correction('correction-1', 'Run focused tests first.');

    const writes = [
      await writeEvent(root, first),
      await writeEvent(root, correction('correction-1', 'A different summary.')),
    ];

    const path = join(eventDirectory(root), 'correction-1.json');

    expect({
      writes,
      names: await readdir(eventDirectory(root)),
      read: await readEvents(root),
    }).toEqual({
      writes: [
        { path, outcome: 'saved' },
        { path, outcome: 'existing' },
      ],
      names: ['correction-1.json'],
      read: { events: [first], gaps: [] },
    });
  });

  it('throws a write error other than an existing event', async () => {
    const root = await createProject();
    await mkdir(eventDirectory(root), { recursive: true });
    await chmod(eventDirectory(root), 0o500);
    cleanups.push(() => chmod(eventDirectory(root), 0o700));

    await expect(writeEvent(root, correction('correction-1', 'Locked.'))).rejects.toThrow('EACCES');

    expect(await readdir(eventDirectory(root))).toEqual([]);
  });

  it.each(['../escape', 'a/b', '.hidden', ''])('refuses the unsafe event ID %j', async (id) => {
    const root = await createProject();

    await expect(writeEvent(root, correction(id, 'Escape.'))).rejects.toThrow(
      'is not a safe file name',
    );

    expect({
      tauDirectory: existsSync(join(root, '.tau')),
      escaped: existsSync(join(root, 'escape.json')),
    }).toEqual({ tauDirectory: false, escaped: false });
  });
});
