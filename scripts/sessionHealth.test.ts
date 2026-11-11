import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { collectSessions } from './sessionHealth.js';

let agentDirectory: string;

const window = {
  since: Date.parse('2026-10-02T00:00:00Z'),
  until: Date.parse('2026-10-05T00:00:00Z'),
};

const header = (timestamp: string) => JSON.stringify({ type: 'session', id: 's', timestamp });

const call = (id: string, tool: string, timestamp = '2026-10-03T10:00:00Z') =>
  JSON.stringify({
    type: 'message',
    id,
    timestamp,
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name: tool, arguments: {} }] },
  });

const write = async (path: string, lines: string[]) => {
  const target = join(agentDirectory, path);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${lines.join('\n')}\n`);

  return target;
};

const tools = (calls: { tool: string; side: string }[]) =>
  calls.map((entry) => `${entry.side} ${entry.tool}`).toSorted();

beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), 'tau-session-health-'));
});

afterEach(async () => {
  await rm(agentDirectory, { recursive: true, force: true });
});

it('reads manager sessions and worker sessions of assignments and older workers', async () => {
  const started = header('2026-10-03T09:00:00Z');

  await write('sessions/--repo--/m.jsonl', [started, call('a', 'subagent')]);
  await write('tau/repo-1/assignments/x/w.jsonl', [started, call('b', 'run_tests')]);
  await write('tau/repo-1/workers/y/w.jsonl', [started, call('c', 'subagent_report')]);
  await write('tau/inbox/z/message.jsonl', [started, call('d', 'other')]);

  const { collection, unreadableFiles } = await collectSessions(agentDirectory, window);

  expect(unreadableFiles).toBe(0);
  expect([collection.managerFiles, collection.workerFiles]).toEqual([1, 2]);

  expect(tools(collection.calls)).toEqual([
    'manager subagent',
    'worker run_tests',
    'worker subagent_report',
  ]);
});

it('returns nothing for an agent directory without sessions', async () => {
  const { collection, unreadableFiles } = await collectSessions(agentDirectory, window);

  expect(unreadableFiles).toBe(0);
  expect(collection.calls).toEqual([]);
});

it('counts a session without a readable header as unreadable', async () => {
  await write('sessions/--repo--/broken.jsonl', ['{not json', call('a', 'bash')]);
  await write('sessions/--repo--/headless.jsonl', [call('b', 'bash')]);

  const { collection, unreadableFiles } = await collectSessions(agentDirectory, window);

  expect(unreadableFiles).toBe(2);
  expect(collection.calls).toEqual([]);
});

it('skips sessions last written before the window or started after it', async () => {
  const old = await write('sessions/--repo--/old.jsonl', [
    header('2026-10-01T09:00:00Z'),
    call('a', 'bash'),
  ]);

  await utimes(old, new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'));

  await write('sessions/--repo--/later.jsonl', [
    header('2026-10-06T09:00:00Z'),
    call('b', 'bash', '2026-10-06T10:00:00Z'),
  ]);

  const { collection, unreadableFiles } = await collectSessions(agentDirectory, window);

  expect(unreadableFiles).toBe(0);
  expect(collection.managerFiles).toBe(0);
});

it('keeps a copied entry in the session that started first', async () => {
  const shared = call('a', 'bash');

  await write('sessions/--repo--/b-copy.jsonl', [header('2026-10-03T09:30:00Z'), shared]);

  await write('tau/repo-1/assignments/x/a-original.jsonl', [
    header('2026-10-03T09:00:00Z'),
    shared,
  ]);

  const { collection } = await collectSessions(agentDirectory, window);

  expect(tools(collection.calls)).toEqual(['worker bash']);
  expect(collection.copiedEntries).toBe(1);
});
