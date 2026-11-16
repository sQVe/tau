import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { readTaskSignals } from './taskSignals.ts';
import type { TaskSignalSources } from './taskSignals.ts';

const repository = 'github.com/owner/repo';

const directory = () => temporaryDirectory(onTestFinished, 'tau-task-signals-');

const writeFile = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const snapshot = (paths: readonly string[]) =>
  Object.fromEntries(paths.map((path) => [path, readFileSync(path, 'utf8')]));

const sessionHeader = (cwd: string) =>
  JSON.stringify({ type: 'session', id: 's', timestamp: '2026-11-01T00:00:00.000Z', cwd });

const entry = (id: string, timestamp: string, message: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', id, timestamp, message });

const call = (
  id: string,
  timestamp: string,
  name: string,
  parameters: Record<string, unknown>,
  details: Record<string, unknown> = {},
) => [
  entry(id, timestamp, {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: parameters }],
  }),
  entry(`${id}-result`, timestamp, {
    role: 'toolResult',
    toolCallId: id,
    details,
  }),
];

const published = (pr: number) =>
  call('verify', '2026-11-01T00:01:00.000Z', 'pr', {
    action: 'verify',
    repository,
    pr,
  });

const feedbackRead = (index: number, pr: number) =>
  call(`feedback-${index}`, `2026-11-01T00:0${index + 2}:00.000Z`, 'pr_feedback', {
    action: 'read',
    pr,
  });

const workerLaunch = (workerId: string) =>
  call(
    'launch',
    '2026-11-01T00:01:30.000Z',
    'subagent',
    { profile: 'worker' },
    { taskId: workerId },
  );

const sources = (
  sessionDirectory: string,
  overrides: Partial<TaskSignalSources> = {},
): TaskSignalSources => ({
  agentDirectory: join(sessionDirectory, '..'),
  sessionDirectory,
  cwd: '/repository',
  pullRequest: {
    repository,
    number: 7,
    headBranch: 'me-7-change',
    createdAt: '2026-11-01T00:00:00.000Z',
  },
  ...overrides,
});

const writeTranscript = (sessionDirectory: string, lines: readonly string[]) => {
  writeFile(join(sessionDirectory, 'main.jsonl'), lines.join('\n'));
};

describe('readTaskSignals', () => {
  it('reads the signals of the task that published the pull request', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');

    writeTranscript(sessionDirectory, [
      sessionHeader('/repository'),
      ...published(7),
      ...feedbackRead(1, 7),
      ...feedbackRead(2, 7),
      ...feedbackRead(3, 7),
    ]);

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({
      status: 'read',
      signals: { feedbackRounds: 'fired', revert: 'notFired' },
    });
  });

  it('reads no signal for a task below every threshold', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');

    writeTranscript(sessionDirectory, [
      sessionHeader('/repository'),
      ...published(7),
      ...feedbackRead(1, 7),
    ]);

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({
      status: 'read',
      signals: {
        reviewRounds: 'notFired',
        feedbackRounds: 'notFired',
        checkFailures: 'notFired',
        revert: 'notFired',
      },
    });
  });

  it('reads unknown transcript signals when the session folder is missing', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'absent');

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({
      status: 'read',
      coverage: 'missing',
      signals: {
        reviewRounds: 'unknown',
        feedbackRounds: 'unknown',
        checkFailures: 'unknown',
        revert: 'notFired',
      },
    });
  });

  it('reads unknown signals from a malformed transcript', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');

    writeTranscript(sessionDirectory, [sessionHeader('/repository'), ...published(7), '{not json']);

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({
      status: 'read',
      coverage: 'unknown',
      signals: {
        reviewRounds: 'unknown',
        feedbackRounds: 'unknown',
        checkFailures: 'unknown',
      },
    });
  });

  it('fails when a transcript cannot be read', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');
    const broken = join(sessionDirectory, 'broken.jsonl');

    mkdirSync(broken, { recursive: true });

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read.status).toBe('failed');
    expect(read.status === 'failed' ? read.reason : '').toContain(broken);
  });

  it('skips transcripts last changed before the pull request was created', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');
    const path = join(sessionDirectory, 'main.jsonl');

    writeTranscript(sessionDirectory, [
      sessionHeader('/repository'),
      ...published(7),
      ...feedbackRead(1, 7),
      ...feedbackRead(2, 7),
      ...feedbackRead(3, 7),
    ]);

    const before = new Date('2026-10-31T00:00:00.000Z');

    utimesSync(path, before, before);

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({
      status: 'read',
      coverage: 'missing',
      signals: { feedbackRounds: 'unknown' },
    });
  });

  it('fails when the pull request creation time is not a date', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');

    const read = await readTaskSignals(
      sources(sessionDirectory, {
        pullRequest: {
          repository,
          number: 7,
          headBranch: 'me-7-change',
          createdAt: 'soon',
        },
      }),
    );

    expect(read.status).toBe('failed');
  });

  it('reads unknown coverage when a launched worker record is broken', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');

    writeTranscript(sessionDirectory, [
      sessionHeader('/repository'),
      ...published(7),
      ...workerLaunch('w1'),
    ]);

    writeFile(join(agent, 'tau', 'main-1', 'workers', 'w1', 'task.json'), '{"createdAt":1}');

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({
      status: 'read',
      coverage: 'unknown',
      signals: { feedbackRounds: 'unknown' },
    });
  });

  it('ignores a broken record of a worker the task did not launch', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');

    writeTranscript(sessionDirectory, [sessionHeader('/repository'), ...published(7)]);

    writeFile(join(agent, 'tau', 'main-1', 'workers', 'w2', 'task.json'), '{"createdAt":1}');

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({ status: 'read', coverage: 'complete' });
  });

  it('fails instead of rejecting when worker discovery cannot list the tau folder', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');

    writeTranscript(sessionDirectory, [
      sessionHeader('/repository'),
      ...published(7),
      ...workerLaunch('w1'),
    ]);

    writeFile(join(agent, 'tau'), 'not a directory');

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read.status).toBe('failed');
    expect(read.status === 'failed' ? read.reason : '').toContain('tau');
  });

  it('leaves transcripts and worker records unchanged while reading signals', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');
    const transcript = join(sessionDirectory, 'main.jsonl');
    const record = join(agent, 'tau', 'main-1', 'workers', 'w1', 'task.json');
    const workerSession = join(agent, 'tau', 'main-1', 'workers', 'w1', 'session.jsonl');

    writeFile(
      transcript,
      [sessionHeader('/repository'), ...published(7), ...workerLaunch('w1')].join('\n'),
    );

    writeFile(record, '{"taskId":"w1","createdAt":1}');
    writeFile(workerSession, sessionHeader('/worker'));

    const before = snapshot([transcript, record, workerSession]);
    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({ status: 'read', coverage: 'complete' });
    expect(snapshot([transcript, record, workerSession])).toEqual(before);
  });

  it('reads managerOnly coverage when a launched worker has no record', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');

    writeTranscript(sessionDirectory, [
      sessionHeader('/repository'),
      ...published(7),
      ...workerLaunch('w1'),
    ]);

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({ status: 'read', coverage: 'managerOnly' });
  });

  it('skips a dangling transcript symlink', async () => {
    const agent = directory();
    const sessionDirectory = join(agent, 'sessions');

    mkdirSync(sessionDirectory, { recursive: true });
    symlinkSync(join(agent, 'gone.jsonl'), join(sessionDirectory, 'dangling.jsonl'));

    const read = await readTaskSignals(sources(sessionDirectory));

    expect(read).toMatchObject({ status: 'read', coverage: 'missing' });
  });
});
