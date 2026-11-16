import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { readTranscript, readWorkerRecord, readWorkerTranscripts } from './improvement.ts';
import { mapTasks } from './taskMapping.ts';
import type { WorkerTranscript } from './taskMapping.ts';
import { parseTranscript } from './transcript.ts';

const improvementDirectory = () => temporaryDirectory(onTestFinished, 'tau-improvement-');

const writeFile = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const lock = (path: string) => {
  chmodSync(path, 0o000);

  onTestFinished(() => {
    chmodSync(path, 0o644);
  });
};

const snapshot = (paths: readonly string[]) =>
  Object.fromEntries(paths.map((path) => [path, readFileSync(path, 'utf8')]));

const header = `${JSON.stringify({ type: 'session', id: 's', timestamp: 't', cwd: '/work' })}\n`;

const assignmentRecord = (assignmentId: string, sessionFile: string, version = 3) =>
  JSON.stringify({ version, assignmentId, createdAt: 1, session: { file: sessionFile } });

describe('readTranscript', () => {
  it('reads a transcript file and leaves it unchanged', async () => {
    const path = join(improvementDirectory(), 'session.jsonl');

    writeFile(path, header);

    const before = snapshot([path]);

    expect(await readTranscript(path)).toEqual({ status: 'read', cwd: '/work', calls: [] });
    expect(snapshot([path])).toEqual(before);
  });

  it('reports a transcript file that does not exist as missing', async () => {
    const path = join(improvementDirectory(), 'gone.jsonl');

    expect(await readTranscript(path)).toEqual({ status: 'missing' });
  });

  it('reports a malformed transcript file and leaves it unchanged', async () => {
    const path = join(improvementDirectory(), 'session.jsonl');

    writeFile(path, `${header}{not json\n`);

    const before = snapshot([path]);

    expect(await readTranscript(path)).toMatchObject({ status: 'malformed', cwd: '/work' });
    expect(snapshot([path])).toEqual(before);
  });

  it('reports a transcript that cannot be read as unreadable', async () => {
    const path = improvementDirectory();

    expect(await readTranscript(path)).toMatchObject({ status: 'unreadable' });
  });
});

describe('readWorkerRecord', () => {
  it('reads an assignment record and leaves it unchanged', async () => {
    const path = join(improvementDirectory(), 'assignments', 'a1', 'assignment.json');

    writeFile(path, assignmentRecord('a1', '/s.jsonl'));

    const before = snapshot([path]);

    expect(await readWorkerRecord(path)).toMatchObject({
      status: 'read',
      record: { task: { taskId: 'a1', sessionFile: '/s.jsonl' }, directory: dirname(path) },
    });

    expect(snapshot([path])).toEqual(before);
  });

  it('reports a record file that does not exist as missing', async () => {
    const path = join(improvementDirectory(), 'workers', 't1', 'task.json');

    expect(await readWorkerRecord(path)).toEqual({ status: 'missing' });
  });

  it('reports a malformed record and leaves it unchanged', async () => {
    const path = join(improvementDirectory(), 'workers', 't1', 'task.json');

    writeFile(path, '{"createdAt":1}');

    const before = snapshot([path]);

    expect(await readWorkerRecord(path)).toEqual({ status: 'malformed' });
    expect(snapshot([path])).toEqual(before);
  });

  it('reports an assignment record with a newer version as newer and leaves it unchanged', async () => {
    const path = join(improvementDirectory(), 'assignments', 'a1', 'assignment.json');

    writeFile(path, assignmentRecord('a1', '/s.jsonl', 4));

    const before = snapshot([path]);
    const read = await readWorkerRecord(path);

    const notice = read.status === 'newer' ? read.notice : undefined;

    expect(notice).toContain(path);
    expect(snapshot([path])).toEqual(before);
  });

  it.each([
    { name: 'an older unknown version', version: 0 },
    { name: 'a version that is not a number', version: '4' },
  ])('reports an assignment record with $name as malformed', async ({ version }) => {
    const path = join(improvementDirectory(), 'assignments', 'a1', 'assignment.json');

    writeFile(path, JSON.stringify({ version, assignmentId: 'a1', createdAt: 1 }));

    const before = snapshot([path]);

    expect(await readWorkerRecord(path)).toEqual({ status: 'malformed' });
    expect(snapshot([path])).toEqual(before);
  });

  it('reports a record that cannot be read as unreadable', async () => {
    const path = join(improvementDirectory(), 'workers', 't1', 'task.json');

    writeFile(path, '{"taskId":"t1","createdAt":1}');
    lock(path);

    expect(await readWorkerRecord(path)).toMatchObject({ status: 'unreadable' });
  });
});

describe('readWorkerTranscripts', () => {
  it('finds the transcript of each worker by its record and leaves the files unchanged', async () => {
    const agent = improvementDirectory();
    const tau = join(agent, 'tau', 'main-1');
    const assignmentPath = join(tau, 'assignments', 'a1', 'assignment.json');
    const assignmentSession = join(tau, 'assignments', 'a1', 'session-a.jsonl');
    const taskPath = join(tau, 'workers', 't3', 'task.json');

    writeFile(assignmentPath, assignmentRecord('a1', assignmentSession));
    writeFile(assignmentSession, header);
    writeFile(taskPath, '{"taskId":"t3","createdAt":1}');

    const before = snapshot([assignmentPath, assignmentSession, taskPath]);
    const workers = await readWorkerTranscripts(agent, new Set(['a1', 't3']));

    expect(Object.fromEntries(workers)).toEqual({ a1: 'readable', t3: 'missing' });
    expect(snapshot([assignmentPath, assignmentSession, taskPath])).toEqual(before);
  });

  it('reports a worker session that cannot be read as unreadable', async () => {
    const agent = improvementDirectory();
    const session = join(agent, 'tau', 'main-1', 'workers', 't2', 'session-b.jsonl');

    writeFile(join(dirname(session), 'task.json'), '{"taskId":"t2","createdAt":1}');
    writeFile(session, header);
    lock(session);

    expect(Object.fromEntries(await readWorkerTranscripts(agent, new Set(['t2'])))).toEqual({
      t2: 'unreadable',
    });
  });

  it('reports a worker session that is malformed as unreadable and leaves it unchanged', async () => {
    const agent = improvementDirectory();
    const session = join(agent, 'tau', 'main-1', 'workers', 't6', 'session-c.jsonl');

    writeFile(join(dirname(session), 'task.json'), '{"taskId":"t6","createdAt":1}');
    writeFile(session, `${header}{not json\n`);

    const before = snapshot([session]);

    expect(Object.fromEntries(await readWorkerTranscripts(agent, new Set(['t6'])))).toEqual({
      t6: 'unreadable',
    });

    expect(snapshot([session])).toEqual(before);
  });

  it('reports a worker whose record is malformed or cannot be read as unreadable', async () => {
    const agent = improvementDirectory();
    const workers = join(agent, 'tau', 'main-1', 'workers');
    const locked = join(workers, 't5', 'task.json');
    const malformed = join(workers, 't4', 'task.json');

    writeFile(malformed, '{"createdAt":1}');
    writeFile(locked, '{"taskId":"t5","createdAt":1}');
    lock(locked);

    const before = snapshot([malformed]);

    expect(Object.fromEntries(await readWorkerTranscripts(agent, new Set(['t4', 't5'])))).toEqual({
      t4: 'unreadable',
      t5: 'unreadable',
    });

    expect(snapshot([malformed])).toEqual(before);
  });

  it('reads only the workers whose directory or task ID was requested', async () => {
    const agent = improvementDirectory();
    const workers = join(agent, 'tau', 'main-1', 'workers');

    writeFile(join(workers, 't7', 'task.json'), '{"taskId":"t7","createdAt":1}');
    writeFile(join(workers, 't8', 'task.json'), '{"taskId":"t8","createdAt":1}');
    writeFile(join(workers, 'renamed', 'task.json'), '{"taskId":"t9","createdAt":1}');

    expect(Object.fromEntries(await readWorkerTranscripts(agent, new Set(['t7', 't9'])))).toEqual({
      t7: 'missing',
      t9: 'missing',
    });
  });

  it('reports no workers when the agent directory has no worker records', async () => {
    const agent = improvementDirectory();

    expect(await readWorkerTranscripts(join(agent, 'absent'), new Set())).toEqual(new Map());
  });
});

describe('worker coverage from the records on disk', () => {
  const repository = 'github.com/sQVe/tau';

  const launchTranscript = [
    JSON.stringify({ type: 'session', id: 's', timestamp: 't', cwd: '/work/me-7' }),
    JSON.stringify({
      type: 'message',
      id: 'launch',
      timestamp: '2026-11-03T08:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'subagent', arguments: { profile: 'qa' } }],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'launch-result',
      timestamp: '2026-11-03T08:01:00.000Z',
      message: { role: 'toolResult', toolCallId: 'c1', details: { taskId: 'w1' } },
    }),
  ].join('\n');

  const coverageWith = (workers: ReadonlyMap<string, WorkerTranscript>) =>
    mapTasks({
      pullRequests: [
        {
          repository,
          number: 7,
          url: 'https://github.com/sQVe/tau/pull/7',
          headBranch: 'me-7-change',
          createdAt: '2026-11-01T00:00:00Z',
          mergedAt: '2026-11-02T00:00:00Z',
        },
      ],
      transcripts: [{ path: '/m.jsonl', transcript: parseTranscript(launchTranscript) }],
      repositories: new Map([['/work/me-7', repository]]),
      workers,
    }).tasks[0]?.coverage;

  it('gives coverage unknown when a worker record cannot be read', async () => {
    const agent = improvementDirectory();
    const record = join(agent, 'tau', 'main-1', 'workers', 'w1', 'task.json');

    writeFile(record, '{"taskId":"w1","createdAt":1}');
    lock(record);

    expect(coverageWith(await readWorkerTranscripts(agent, new Set(['w1'])))).toBe('unknown');
  });

  it('gives coverage unknown when a worker record has a newer format', async () => {
    const agent = improvementDirectory();
    const record = join(agent, 'tau', 'main-1', 'assignments', 'w1', 'assignment.json');

    writeFile(record, assignmentRecord('w1', '/s.jsonl', 4));

    expect(coverageWith(await readWorkerTranscripts(agent, new Set(['w1'])))).toBe('unknown');
  });

  it('gives coverage managerOnly when a worker record is missing', async () => {
    const agent = improvementDirectory();

    mkdirSync(join(agent, 'tau', 'main-1', 'workers', 'w1'), { recursive: true });

    expect(coverageWith(await readWorkerTranscripts(agent, new Set(['w1'])))).toBe('managerOnly');
  });
});
