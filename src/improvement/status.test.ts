import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.ts';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
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

const snapshot = async (projectRoot: string, agentDirectory: string) => {
  const directory = eventDirectory(projectRoot);
  const names = (await readdir(directory)).toSorted();

  const events = await Promise.all(
    names.map(async (name) => [name, await readFile(join(directory, name), 'utf8')] as const),
  );

  return { events, index: await readFile(sweepIndexPath(agentDirectory), 'utf8') };
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
    skipped: [],
  });

  expect(await snapshot(projectRoot, agentDirectory)).toEqual(before);
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
    skipped: [],
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

it('rejects a damaged event with an error naming its path', async () => {
  const project = await createProject();
  const agentDirectory = createAgentDirectory();
  const path = join(eventDirectory(await realpath(project)), 'broken.json');

  await mkdir(eventDirectory(await realpath(project)), { recursive: true });
  await writeFile(path, '{');

  await expect(readImprovementStatus({ cwd: project, agentDirectory, now })).rejects.toThrow(path);
});

it('reads a malformed index as an incomplete sweep', async () => {
  const project = await createProject();
  const agentDirectory = createAgentDirectory();
  const path = sweepIndexPath(agentDirectory);

  await mkdir(join(agentDirectory, 'tau', 'improvement'), { recursive: true });
  await writeFile(path, 'not JSON');

  const status = await readImprovementStatus({ cwd: project, agentDirectory, now });

  expect(status.sweep).toBe('incomplete');
});

it('lists a newer-format event in skipped', async () => {
  const project = await createProject();
  const projectRoot = await realpath(project);
  const agentDirectory = createAgentDirectory();
  const directory = eventDirectory(projectRoot);
  const path = join(directory, 'newer.json');

  await mkdir(directory, { recursive: true });
  await writeFile(path, JSON.stringify({ version: 2, id: 'newer' }));

  const status = await readImprovementStatus({ cwd: project, agentDirectory, now });

  expect(status.skipped.map((entry) => entry.path)).toEqual([path]);
});
