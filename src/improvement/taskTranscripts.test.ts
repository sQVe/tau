import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import {
  published,
  repository,
  sessionHeader,
  workerLaunch,
} from '../../tests/transcriptHarness.js';
import type { TaskSignalSources } from './taskSignals.ts';
import { readTaskTranscripts } from './taskTranscripts.ts';

const writeFile = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const sources = (
  cwd: string,
  sessionDirectory: string,
  overrides: Partial<TaskSignalSources> = {},
): TaskSignalSources => ({
  agentDirectory: join(sessionDirectory, '..'),
  sessionDirectory,
  cwd,
  pullRequest: {
    repository,
    number: 7,
    url: 'https://github.com/owner/repo/pull/7',
    headBranch: 'me-7-change',
    createdAt: '2026-11-01T00:00:00.000Z',
    mergedAt: '2026-11-02T00:00:00.000Z',
  },
  ...overrides,
});

const writeTranscript = (sessionDirectory: string, lines: readonly string[]) => {
  writeFile(join(sessionDirectory, 'main.jsonl'), lines.join('\n'));
};

it('reads the manager and worker transcript paths of a complete task', async () => {
  const cwd = await createTemporaryRepository(onTestFinished);
  const agent = temporaryDirectory(onTestFinished, 'tau-task-transcripts-');
  const sessionDirectory = join(agent, 'sessions');
  const manager = join(sessionDirectory, 'main.jsonl');
  const worker = join(agent, 'tau', 'main-1', 'workers', 'w1', 'session.jsonl');

  writeTranscript(sessionDirectory, [sessionHeader(cwd), ...published(7), ...workerLaunch('w1')]);

  writeFile(
    join(agent, 'tau', 'main-1', 'workers', 'w1', 'task.json'),
    '{"taskId":"w1","createdAt":1}',
  );

  writeFile(worker, sessionHeader('/worker'));

  const read = await readTaskTranscripts(sources(cwd, sessionDirectory));

  expect(read).toEqual({
    status: 'read',
    manager: [manager],
    workers: [worker],
    coverage: 'complete',
  });
});

it('reads no transcript paths when the session folder is missing', async () => {
  const cwd = await createTemporaryRepository(onTestFinished);
  const agent = temporaryDirectory(onTestFinished, 'tau-task-transcripts-');
  const sessionDirectory = join(agent, 'absent');

  const read = await readTaskTranscripts(sources(cwd, sessionDirectory));

  expect(read).toEqual({
    status: 'read',
    manager: [],
    workers: [],
    coverage: 'missing',
  });
});

it('reads unknown coverage from a damaged transcript', async () => {
  const cwd = await createTemporaryRepository(onTestFinished);
  const agent = temporaryDirectory(onTestFinished, 'tau-task-transcripts-');
  const sessionDirectory = join(agent, 'sessions');

  writeTranscript(sessionDirectory, [sessionHeader(cwd), ...published(7), '{not json']);

  const read = await readTaskTranscripts(sources(cwd, sessionDirectory));

  expect(read).toMatchObject({ status: 'read', coverage: 'unknown' });
  const coverage = read.status === 'read' ? read.coverage : 'failed';
  expect(coverage).not.toBe('complete');
});

it('fails when the session folder is a regular file', async () => {
  const cwd = await createTemporaryRepository(onTestFinished);
  const agent = temporaryDirectory(onTestFinished, 'tau-task-transcripts-');
  const sessionDirectory = join(agent, 'sessions');

  writeFile(sessionDirectory, 'not a directory');

  const read = await readTaskTranscripts(sources(cwd, sessionDirectory));

  expect(read.status).toBe('failed');
  const failureReason = read.status === 'failed' ? read.reason : '';
  expect(failureReason).toContain(sessionDirectory);
});

it('reads unknown coverage from an unreadable worker record', async () => {
  const cwd = await createTemporaryRepository(onTestFinished);
  const agent = temporaryDirectory(onTestFinished, 'tau-task-transcripts-');
  const sessionDirectory = join(agent, 'sessions');

  writeTranscript(sessionDirectory, [sessionHeader(cwd), ...published(7), ...workerLaunch('w1')]);
  writeFile(join(agent, 'tau', 'main-1', 'workers', 'w1', 'task.json'), '{"createdAt":1}');

  const read = await readTaskTranscripts(sources(cwd, sessionDirectory));

  expect(read).toMatchObject({ status: 'read', workers: [], coverage: 'unknown' });
  const coverage = read.status === 'read' ? read.coverage : 'failed';
  expect(coverage).not.toBe('complete');
});
