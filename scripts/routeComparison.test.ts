import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'routeComparison.ts');

const switchTime = Date.parse('2026-11-01T00:00:00Z');
const before = switchTime - 60_000;
const after = switchTime + 60_000;

let agentDirectory: string;

const write = async (path: string, content: string) => {
  const target = join(agentDirectory, path);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);

  return target;
};

const taskRecord = (version: number, taskId: string, createdAt: number) =>
  JSON.stringify({
    version,
    taskId,
    createdAt,
    parentSession: '/home/user/session.jsonl',
    loadout: { profile: 'worker', model: 'model-a', cwd: '/repo' },
    routing: { label: 'routine' },
    predecessorTaskId: null,
  });

const report = JSON.stringify({ outcome: 'success', summary: 'Done' });

const run = (extra: string[] = [], directory = agentDirectory) =>
  spawnSync(
    process.execPath,
    [
      script,
      '--profile',
      'worker',
      '--label',
      'routine',
      '--switch',
      '2026-11-01T00:00:00Z',
      '--agent-directory',
      directory,
      ...extra,
    ],
    { encoding: 'utf8' },
  );

const countOf = (output: string, label: string) => {
  const match = new RegExp(`${label}: (\\d+) launches`).exec(output);

  return match === null ? undefined : Number(match[1]);
};

const snapshot = async () => {
  const names = await readdir(agentDirectory, { recursive: true, encoding: 'utf8' });

  return Promise.all(
    names.toSorted().map(async (name) => {
      const path = join(agentDirectory, name);
      const info = await stat(path);

      return [name, info.mtimeMs, info.isFile() ? await readFile(path, 'utf8') : ''];
    }),
  );
};

const sideSection = (output: string, label: string) => {
  const start = output.indexOf(label);
  const end = label === 'Before switch' ? output.indexOf('After switch') : output.length;

  return output.slice(start, end);
};

const timeToReport = (section: string) => {
  const match =
    /time to first report: median (([\d.]+)|none) min \((\d+) measured, (\d+) without a readable report\)/.exec(
      section,
    );

  if (match === null) {
    return undefined;
  }

  return { median: match[1], measured: Number(match[3]), missing: Number(match[4]) };
};

const successCount = (section: string) => {
  const match = /success: (\d+) success,/.exec(section);

  return match === null ? undefined : Number(match[1]);
};

const noReportCount = (section: string) => {
  const match = /success: \d+ success, \d+ failure, \d+ incomplete, (\d+) no report/.exec(section);

  return match === null ? undefined : Number(match[1]);
};

const writeAllFormats = async () => {
  await write('tau-archive/proj/archive-before/task.json', taskRecord(8, 'archive-before', before));
  await write('tau-archive/proj/archive-before/report.json', report);
  await write('tau/proj/workers/worker-after/task.json', taskRecord(11, 'worker-after', after));
  await write('tau/proj/workers/worker-after/report.json', report);

  const sessionPath = await write(
    'tau/proj/assignments/assignment-after/session.jsonl',
    `${JSON.stringify({
      type: 'message',
      timestamp: '2026-11-01T00:01:00Z',
      message: { role: 'toolResult', toolName: 'subagent_report', isError: false },
    })}\n`,
  );

  await write(
    'tau/proj/assignments/assignment-after/assignment.json',
    JSON.stringify({
      version: 3,
      assignmentId: 'assignment-after',
      createdAt: after,
      profile: 'worker',
      cwd: '/repo',
      parentSession: '/home/user/session.jsonl',
      routing: { label: 'routine' },
      session: { file: sessionPath },
      report: { outcome: 'success', summary: 'Done' },
    }),
  );
};

beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), 'tau-route-comparison-'));
});

afterEach(async () => {
  await rm(agentDirectory, { recursive: true, force: true });
});

it('lists each format launch on its switch side with --list', async () => {
  await writeAllFormats();

  const result = run(['--list']);

  expect(result.status).toBe(0);

  const output = result.stdout;

  const beforeSection = output.slice(
    output.indexOf('Before switch'),
    output.indexOf('After switch'),
  );

  const afterSection = output.slice(output.indexOf('After switch'));

  expect(beforeSection).toContain('archive-before');
  expect(beforeSection).not.toContain('worker-after');
  expect(afterSection).toContain('worker-after');
  expect(afterSection).toContain('assignment-after');
});

it('hides launch ids by default and shows them only with --list', async () => {
  await writeAllFormats();

  const plain = run();
  const listed = run(['--list']);

  expect(plain.status).toBe(0);
  expect(plain.stdout).not.toContain('archive-before');
  expect(countOf(plain.stdout, 'Before switch')).toBe(1);
  expect(countOf(plain.stdout, 'After switch')).toBe(2);
  expect(listed.stdout).toContain('archive-before');
});

it('counts no launches for a missing agent directory', () => {
  const result = run([], join(agentDirectory, 'does-not-exist'));

  expect(result.status).toBe(0);
  expect(countOf(result.stdout, 'Before switch')).toBe(0);
  expect(countOf(result.stdout, 'After switch')).toBe(0);
});

it('counts unparsable and unknown-version records as skipped', async () => {
  await write('tau-archive/proj/unparsable/task.json', '{ not json');

  await write(
    'tau/proj/workers/unknown-version/task.json',
    taskRecord(12, 'unknown-version', before),
  );

  const result = run();

  expect(result.status).toBe(0);
  expect(/Skipped (\d+)/.exec(result.stdout)?.[1]).toBe('2');
  expect(countOf(result.stdout, 'Before switch')).toBe(0);
});

it('leaves the record files unchanged after a run', async () => {
  await writeAllFormats();

  const beforeState = await snapshot();
  const result = run(['--list']);
  const afterState = await snapshot();

  expect(result.status).toBe(0);
  expect(afterState).toEqual(beforeState);
});

it('feeds report file times and outcomes into each side measure', async () => {
  const taskReport = await write('tau-archive/proj/archive-before/report.json', report);
  await write('tau-archive/proj/archive-before/task.json', taskRecord(8, 'archive-before', before));
  await utimes(taskReport, new Date(before + 300_000), new Date(before + 300_000));

  const sessionPath = await write(
    'tau/proj/assignments/assignment-after/session.jsonl',
    `${JSON.stringify({
      type: 'message',
      timestamp: new Date(after + 180_000).toISOString(),
      message: { role: 'toolResult', toolName: 'subagent_report', isError: false },
    })}\n`,
  );

  await write(
    'tau/proj/assignments/assignment-after/assignment.json',
    JSON.stringify({
      version: 3,
      assignmentId: 'assignment-after',
      createdAt: after,
      profile: 'worker',
      cwd: '/repo',
      routing: { label: 'routine' },
      session: { file: sessionPath },
      report: { outcome: 'success', summary: 'Done' },
    }),
  );

  const result = run();

  expect(result.status).toBe(0);

  const beforeSection = sideSection(result.stdout, 'Before switch');
  const afterSection = sideSection(result.stdout, 'After switch');

  expect(timeToReport(beforeSection)?.median).toBe('5.0');
  expect(timeToReport(beforeSection)?.missing).toBe(0);
  expect(successCount(beforeSection)).toBe(1);

  expect(timeToReport(afterSection)?.median).toBe('3.0');
  expect(timeToReport(afterSection)?.missing).toBe(0);
  expect(successCount(afterSection)).toBe(1);
});

it('counts launches whose report files are missing', async () => {
  await write('tau-archive/proj/archive-before/task.json', taskRecord(8, 'archive-before', before));

  await write(
    'tau/proj/assignments/assignment-after/assignment.json',
    JSON.stringify({
      version: 3,
      assignmentId: 'assignment-after',
      createdAt: after,
      profile: 'worker',
      cwd: '/repo',
      routing: { label: 'routine' },
      session: { file: join(agentDirectory, 'missing.jsonl') },
    }),
  );

  const result = run();

  expect(result.status).toBe(0);

  const beforeSection = sideSection(result.stdout, 'Before switch');
  const afterSection = sideSection(result.stdout, 'After switch');

  expect(timeToReport(beforeSection)?.missing).toBe(1);
  expect(noReportCount(beforeSection)).toBe(1);
  expect(timeToReport(afterSection)?.missing).toBe(1);
  expect(noReportCount(afterSection)).toBe(1);
});
