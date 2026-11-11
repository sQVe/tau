import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { parseTime, findUsageRecords } from './tokenUsage.js';

let agentDirectory: string;

const since = Date.parse('2026-09-01T00:00:00Z');

const write = async (path: string, content: string) => {
  const target = join(agentDirectory, path);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);

  return target;
};

const taskRecord = (taskId: string, createdAt: number, sessionFile?: string, harness = 'pi') =>
  JSON.stringify({
    taskId,
    createdAt,
    nativeSessionFile: sessionFile,
    loadout: { harness, profile: 'scout' },
  });

const nothing = { sessions: [], skipped: { unreadableFiles: 0, otherHarnessTasks: [] } };

const snapshot = async () => {
  const names = await readdir(agentDirectory, { recursive: true, encoding: 'utf8' });

  return Promise.all(
    names.toSorted().map(async (name) => {
      const path = join(agentDirectory, name);

      const { mtimeMs, isFile } = await stat(path).then((info) => ({
        mtimeMs: info.mtimeMs,
        isFile: info.isFile(),
      }));

      return [name, mtimeMs, isFile ? await readFile(path, 'utf8') : ''];
    }),
  );
};

beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), 'tau-token-usage-'));
});

afterEach(async () => {
  await rm(agentDirectory, { recursive: true, force: true });
});

it('reads parent sessions and worker sessions with every task that shares them', async () => {
  const parent = await write('sessions/--repo--/p.jsonl', '{}\n');
  const worker = await write('tau/repo-1/workers/a/s.jsonl', '{}\n');
  await write('tau/repo-1/workers/a/task.json', taskRecord('a', 1));
  await write('tau/repo-1/workers/b/task.json', taskRecord('b', 2, worker));
  const before = await snapshot();

  const records = await findUsageRecords(agentDirectory, since);

  expect(await snapshot()).toEqual(before);
  expect(records.skipped.unreadableFiles).toBe(0);

  const sessions = records.sessions
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map((session) => [
      session.path,
      session.side,
      session.tasks.map((task) => task.taskId).toSorted(),
    ]);

  expect(sessions).toEqual([
    [parent, 'parent', []],
    [worker, 'worker', ['a', 'b']],
  ]);
});

it.each([
  { rule: 'a first line longer than one read', first: 'x'.repeat(70_000), rest: '\n{}\n' },
  { rule: 'a first line that ends the file', first: '{"type":"session"}', rest: '' },
  { rule: 'an empty file', first: '', rest: '' },
])('returns the first line of a session file for $rule', async ({ first, rest }) => {
  await write('sessions/--repo--/p.jsonl', `${first}${rest}`);

  const records = await findUsageRecords(agentDirectory, since);

  expect(records.sessions.map((session) => session.firstLine)).toEqual([first]);
});

it('returns nothing for an agent directory without sessions', async () => {
  const records = await findUsageRecords(agentDirectory, since);

  expect(records).toEqual(nothing);
});

it('fails when a records directory cannot be read', async () => {
  await write('tau', 'not a directory');

  await expect(findUsageRecords(agentDirectory, since)).rejects.toMatchObject({ code: 'ENOTDIR' });
});

it('counts a malformed task record and still reads the session beside it', async () => {
  const worker = await write('tau/repo-1/workers/a/s.jsonl', '{}\n');
  await write('tau/repo-1/workers/a/task.json', '{"taskId":');

  const records = await findUsageRecords(agentDirectory, since);

  expect(records.skipped.unreadableFiles).toBe(1);
  expect(records.sessions.map((session) => [session.path, session.tasks])).toEqual([[worker, []]]);
});

it('ignores a malformed task record whose session lies outside the window', async () => {
  const old = await write('tau/repo-1/workers/a/s.jsonl', '{}\n');
  await utimes(old, new Date(since - 1000), new Date(since - 1000));
  await write('tau/repo-1/workers/a/task.json', '{"taskId":');
  await write('tau/repo-1/workers/b/task.json', '{"taskId":');

  const records = await findUsageRecords(agentDirectory, since);

  expect(records).toEqual(nothing);
});

it('returns Claude and Codex worker tasks, which have no Pi session', async () => {
  await write('tau/repo-1/workers/a/task.json', taskRecord('a', 1, undefined, 'generic'));

  const records = await findUsageRecords(agentDirectory, since);

  expect(records.sessions).toEqual([]);
  expect(records.skipped.otherHarnessTasks.map((task) => task.taskId)).toEqual(['a']);
});

it('skips session files outside task directories and files last written before the window', async () => {
  await write('tau/memory/notes.jsonl', '{}\n');
  const old = await write('sessions/--repo--/old.jsonl', '{}\n');
  await utimes(old, new Date(since - 1000), new Date(since - 1000));

  const records = await findUsageRecords(agentDirectory, since);

  expect(records).toEqual(nothing);
});

it('reports many session files that share one large log within a 64 MiB heap', async () => {
  const lines = [
    { type: 'session', timestamp: '2026-09-01T00:00:00Z', cwd: '/fixture' },
    {
      type: 'message',
      id: 'padding',
      timestamp: '2026-09-01T00:00:01Z',
      message: { role: 'user', content: 'x'.repeat(1024 * 1024) },
    },
    {
      type: 'message',
      id: 'turn',
      timestamp: '2026-09-01T00:00:02Z',
      message: { role: 'assistant', model: 'fixture', usage: { input: 10, output: 2 } },
    },
  ];

  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  const shared = await write('.pi/agent/shared.jsonl', text);
  const parents = join(agentDirectory, '.pi/agent/sessions/fixture');

  await mkdir(parents, { recursive: true });

  await Promise.all(
    Array.from({ length: 96 }, (_, index) => symlink(shared, join(parents, `${index}.jsonl`))),
  );

  // The script reads the agent directory under the home directory.
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=64',
      join(import.meta.dirname, 'tokenUsage.ts'),
      '--since',
      '2026-09-01T00:00:00Z',
      '--until',
      '2026-09-02T00:00:00Z',
    ],
    { encoding: 'utf8', env: { ...process.env, HOME: agentDirectory } },
  );

  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('96 session files, 0 unreadable');
  expect(result.stdout).toContain('285 copied entries counted once');
  expect(result.stdout).toMatch(/parent +fixture +1 +1 +12 +10 +10/);
});

it.each([
  { rule: 'reads an age in days', value: '2d', time: since - 2 * 86_400_000 },
  {
    rule: 'reads an ISO time',
    value: '2026-08-01T00:00:00Z',
    time: Date.parse('2026-08-01T00:00:00Z'),
  },
])('$rule', ({ value, time }) => {
  expect(parseTime(value, since)).toBe(time);
});

it.each(['7', 'soon'])('rejects the time "%s"', (value) => {
  expect(() => parseTime(value, since)).toThrow(TypeError);
});
