import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.ts';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { isMissingFile } from '../errors.ts';
import { writeEvent } from './event.ts';
import type { ImprovementEvent } from './event.ts';
import { readImprovementStatus } from './status.ts';
import { sweepIndexPath, writeSweepIndex } from './sweepIndex.ts';
import type { SweepIndex } from './sweepIndex.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const createProject = () => createTemporaryRepository((cleanup) => cleanups.push(cleanup));

const createAgentDirectory = () => temporaryDirectory(onTestFinished, 'tau-agent-');

const now = new Date('2026-11-15T13:00:00.000Z');

const pullRequest = 'https://github.com/sQVe/tau/pull/562';

const evidence: { kind: 'pullRequest'; url: string }[] = [
  { kind: 'pullRequest', url: pullRequest },
];

const mergeEvent: ImprovementEvent = {
  version: 1,
  id: 'merge-562',
  kind: 'merge',
  createdAt: '2026-11-15T12:00:00.000Z',
  evidence,
  repository: 'github.com/sQVe/tau',
  pullRequest,
  mergedAt: '2026-11-15T11:58:00.000Z',
};

const factsEvent: ImprovementEvent = {
  version: 1,
  id: 'facts-562',
  kind: 'facts',
  createdAt: '2026-11-15T12:01:00.000Z',
  evidence,
  pullRequest,
  facts: { reviewCaptures: 5 },
  coverage: 'complete',
};

const correctionEvent: ImprovementEvent = {
  version: 1,
  id: 'correction-1',
  kind: 'correction',
  createdAt: '2026-11-15T12:02:00.000Z',
  evidence: [],
  summary: 'Run the focused tests first.',
  cwd: '/code/tau',
};

const caughtUpIndex = (projectRoot: string): SweepIndex => ({
  version: 1,
  transcripts: {},
  projects: {
    [projectRoot]: {
      repository: 'sqve/tau',
      merged: { status: 'read', at: '2026-11-15T12:00:00.000Z', count: 1 },
    },
  },
  lastSweep: { startedAt: '2026-11-15T12:00:00.000Z', outcome: 'caughtUp' },
});

const eventDirectory = (projectRoot: string) => join(projectRoot, '.tau', 'improvement');

const readOptional = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const listEventNames = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory)).toSorted();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const snapshot = async (projectRoot: string, agentDirectory: string) => {
  const directory = eventDirectory(projectRoot);
  const names = await listEventNames(directory);

  const events = await Promise.all(
    names.map(async (name) => [name, await readFile(join(directory, name), 'utf8')] as const),
  );

  return { events, index: await readOptional(sweepIndexPath(agentDirectory)) };
};

it('reads tasks, coverage, the correct pass, and the sweep from saved records', async () => {
  const project = await createProject();
  const projectRoot = await realpath(project);
  const agentDirectory = createAgentDirectory();

  await writeEvent(projectRoot, mergeEvent);
  await writeEvent(projectRoot, factsEvent);
  await writeEvent(projectRoot, correctionEvent);
  await writeSweepIndex(agentDirectory, caughtUpIndex(projectRoot));

  const before = await snapshot(projectRoot, agentDirectory);

  const status = await readImprovementStatus({ cwd: project, agentDirectory, now });

  expect(status).toEqual({
    projectRoot,
    tasks: [
      {
        pullRequest,
        mergedAt: '2026-11-15T11:58:00.000Z',
        signals: ['reviewRounds'],
      },
    ],
    correctDue: true,
    coverage: { complete: 1, managerOnly: 0, missing: 0 },
    sweep: 'complete',
    gaps: [],
  });

  expect(await snapshot(projectRoot, agentDirectory)).toEqual(before);
});

it('reads a failed session sweep as incomplete despite a caught-up index', async () => {
  const project = await createProject();
  const projectRoot = await realpath(project);
  const agentDirectory = createAgentDirectory();

  await writeSweepIndex(agentDirectory, caughtUpIndex(projectRoot));

  const status = await readImprovementStatus({
    cwd: project,
    agentDirectory,
    now,
    sessionSweep: { outcome: 'failed', reason: 'lock failed' },
  });

  expect(status.sweep).toBe('incomplete');
});

it('reads a repository with no events and no index as empty and incomplete', async () => {
  const project = await createProject();
  const projectRoot = await realpath(project);
  const agentDirectory = createAgentDirectory();

  const status = await readImprovementStatus({ cwd: project, agentDirectory, now });

  expect(status).toEqual({
    projectRoot,
    tasks: [],
    correctDue: false,
    coverage: { complete: 0, managerOnly: 0, missing: 0 },
    sweep: 'incomplete',
    gaps: [],
  });
});

it('reads a cwd outside any repository as a null project root', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-outside-');
  const agentDirectory = createAgentDirectory();

  const status = await readImprovementStatus({ cwd: directory, agentDirectory, now });

  expect(status.projectRoot).toBeNull();
  expect(status.tasks).toEqual([]);
});

it('rejects a cwd that does not exist', async () => {
  const project = await createProject();
  const agentDirectory = createAgentDirectory();

  await expect(
    readImprovementStatus({ cwd: join(project, 'missing'), agentDirectory, now }),
  ).rejects.toThrow(/git rev-parse/u);
});

it('reads the status when event files are unreadable and reports each as a gap', async () => {
  const project = await createProject();
  const projectRoot = await realpath(project);
  const agentDirectory = createAgentDirectory();
  const directory = eventDirectory(projectRoot);
  const fixtureDirectory = join(import.meta.dirname, 'fixtures', 'unreadable-events');

  await writeEvent(projectRoot, mergeEvent);

  const names = (await readdir(fixtureDirectory)).toSorted();

  for (const name of names) {
    const text = await readFile(join(fixtureDirectory, name), 'utf8');

    await writeFile(join(directory, name), text);
  }

  const status = await readImprovementStatus({ cwd: project, agentDirectory, now });

  expect(status.tasks).toEqual([]);
  expect(status.coverage).toEqual({ complete: 0, managerOnly: 0, missing: 1 });
  expect(status.correctDue).toBe(true);
  expect(status.gaps.map((gap) => gap.path)).toEqual(names.map((name) => join(directory, name)));
  expect(status.gaps.every((gap) => gap.reason.length > 0)).toBe(true);
});

it('reads a damaged event as a gap and returns the readable status', async () => {
  const project = await createProject();
  const projectRoot = await realpath(project);
  const agentDirectory = createAgentDirectory();
  const path = join(eventDirectory(projectRoot), 'broken.json');

  await mkdir(eventDirectory(projectRoot), { recursive: true });
  await writeFile(path, '{');

  const before = await snapshot(projectRoot, agentDirectory);

  const status = await readImprovementStatus({ cwd: project, agentDirectory, now });

  expect(status.gaps.map((gap) => gap.path)).toEqual([path]);
  expect(status.gaps[0]?.reason).toContain(path);
  expect(status.correctDue).toBe(true);
  expect(await snapshot(projectRoot, agentDirectory)).toEqual(before);
});

it('reads a malformed index as an incomplete sweep', async () => {
  const project = await createProject();
  const projectRoot = await realpath(project);
  const agentDirectory = createAgentDirectory();
  const path = sweepIndexPath(agentDirectory);

  await mkdir(join(agentDirectory, 'tau', 'improvement'), { recursive: true });
  await writeFile(path, 'not JSON');

  const before = await snapshot(projectRoot, agentDirectory);

  const status = await readImprovementStatus({ cwd: project, agentDirectory, now });

  expect(status.sweep).toBe('incomplete');
  expect(await snapshot(projectRoot, agentDirectory)).toEqual(before);
});

it('lists a newer-format event in gaps', async () => {
  const project = await createProject();
  const projectRoot = await realpath(project);
  const agentDirectory = createAgentDirectory();
  const directory = eventDirectory(projectRoot);
  const path = join(directory, 'newer.json');

  await mkdir(directory, { recursive: true });
  await writeFile(path, JSON.stringify({ version: 2, id: 'newer' }));

  const status = await readImprovementStatus({ cwd: project, agentDirectory, now });

  expect(status.gaps.map((gap) => gap.path)).toEqual([path]);
  expect(status.gaps[0]?.reason).toContain('newer format');
});
