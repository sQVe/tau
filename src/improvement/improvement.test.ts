import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { readTranscript, readWorkerTranscripts } from './improvement.ts';

const temporaryDirectory = () => {
  const root = mkdtempSync('/tmp/tau-improvement-');

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return root;
};

const writeFile = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const header = `${JSON.stringify({ type: 'session', id: 's', timestamp: 't', cwd: '/work' })}\n`;

describe('readTranscript', () => {
  it('reads a transcript file', async () => {
    const path = join(temporaryDirectory(), 'session.jsonl');

    writeFile(path, header);

    expect(await readTranscript(path)).toEqual({ status: 'read', cwd: '/work', calls: [] });
  });

  it('reports a transcript file that does not exist as missing', async () => {
    const path = join(temporaryDirectory(), 'gone.jsonl');

    expect(await readTranscript(path)).toEqual({ status: 'missing' });
  });

  it('reports a transcript that cannot be read as unreadable', async () => {
    const path = temporaryDirectory();

    expect(await readTranscript(path)).toMatchObject({ status: 'unreadable' });
  });
});

describe('readWorkerTranscripts', () => {
  it('finds the transcript of each worker by its record', async () => {
    const agent = temporaryDirectory();
    const tau = join(agent, 'tau', 'main-1');
    const assignmentSession = join(tau, 'assignments', 'a1', 'session-a.jsonl');
    const lockedSession = join(tau, 'workers', 't2', 'session-b.jsonl');

    writeFile(
      join(tau, 'assignments', 'a1', 'assignment.json'),
      JSON.stringify({
        version: 3,
        assignmentId: 'a1',
        createdAt: 1,
        session: { file: assignmentSession },
      }),
    );

    writeFile(assignmentSession, header);
    writeFile(join(tau, 'workers', 't2', 'task.json'), '{"taskId":"t2","createdAt":1}');
    writeFile(lockedSession, header);
    chmodSync(lockedSession, 0o000);
    writeFile(join(tau, 'workers', 't3', 'task.json'), '{"taskId":"t3","createdAt":1}');
    writeFile(join(tau, 'workers', 't4', 'task.json'), '{"createdAt":1}');

    const workers = await readWorkerTranscripts(agent);

    expect(Object.fromEntries(workers)).toEqual({
      a1: 'readable',
      t2: 'unreadable',
      t3: 'missing',
    });
  });
});
