import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { parseThresholds, readParentSessions } from './compactionReplay.js';

let agentDirectory: string;

const since = Date.parse('2026-09-01T00:00:00Z');

const write = async (path: string, content: string) => {
  const target = join(agentDirectory, path);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);

  return target;
};

beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), 'tau-compaction-replay-'));
});

afterEach(async () => {
  await rm(agentDirectory, { recursive: true, force: true });
});

it('reads parent sessions but not worker sessions', async () => {
  const parent = await write('sessions/--repo--/p.jsonl', '{"type":"session"}\n');
  await write('sessions/--repo--/notes.txt', 'not a session');
  await write('tau/repo-1/workers/a/s.jsonl', '{}\n');
  await write('tau/repo-1/workers/a/task.json', '{"taskId":"a","createdAt":1}');

  const records = await readParentSessions(agentDirectory, since);

  expect(records.unreadableFiles).toBe(0);

  expect(records.sessions.map((session) => [session.path, session.side, session.text])).toEqual([
    [parent, 'parent', '{"type":"session"}\n'],
  ]);
});

it('returns nothing without a sessions directory or sessions in the window', async () => {
  const old = await write('sessions/--repo--/old.jsonl', '{}\n');
  await utimes(old, new Date(since - 1000), new Date(since - 1000));

  expect(await readParentSessions(agentDirectory, since)).toEqual({
    sessions: [],
    unreadableFiles: 0,
  });

  await rm(join(agentDirectory, 'sessions'), { recursive: true });

  expect(await readParentSessions(agentDirectory, since)).toEqual({
    sessions: [],
    unreadableFiles: 0,
  });
});

it('passes a malformed session on to the report and counts an unreadable one', async () => {
  const malformed = await write('sessions/--repo--/broken.jsonl', '{"type":\n');
  await mkdir(join(agentDirectory, 'sessions', '--repo--', 'directory.jsonl'));

  const records = await readParentSessions(agentDirectory, since);

  expect(records.unreadableFiles).toBe(1);

  expect(records.sessions.map((session) => [session.path, session.text])).toEqual([
    [malformed, '{"type":\n'],
  ]);
});

it('fails when the sessions directory cannot be read', async () => {
  await write('sessions', 'not a directory');

  await expect(readParentSessions(agentDirectory, since)).rejects.toMatchObject({
    code: 'ENOTDIR',
  });
});

it.each([
  { values: ['150k,200k', '300000'], thresholds: [150_000, 200_000, 300_000] },
  { values: [' 200k '], thresholds: [200_000] },
])('reads thresholds $values', ({ values, thresholds }) => {
  expect(parseThresholds(values)).toEqual(thresholds);
});

it.each(['0', '200m', '-5', ''])('rejects the threshold "%s"', (value) => {
  expect(() => parseThresholds([value])).toThrow(TypeError);
});
