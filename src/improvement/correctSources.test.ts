import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.ts';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { isMissingFile } from '../errors.ts';
import { readCorrectSources } from './correctSources.ts';
import { writeEvent } from './event.ts';
import type { ImprovementEvent } from './event.ts';
import { sweepIndexPath, writeSweepIndex } from './sweepIndex.ts';
import type { SweepIndex } from './sweepIndex.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const createProject = async () =>
  realpath(await createTemporaryRepository((cleanup) => cleanups.push(cleanup)));

const createAgentDirectory = () => temporaryDirectory(onTestFinished, 'tau-agent-');

const correction = (id: string, createdAt: string): ImprovementEvent => ({
  version: 2,
  id,
  kind: 'correction',
  createdAt,
  evidence: [],
  summary: 'Run the focused tests first.',
  cwd: '/code/tau',
});

const indexFor = (projectRoots: string[]): SweepIndex => ({
  version: 1,
  transcripts: {},
  projects: Object.fromEntries(
    projectRoots.map((projectRoot) => [
      projectRoot,
      {
        repository: 'sqve/tau',
        merged: { status: 'read', at: '2026-11-15T12:00:00.000Z', count: 0 },
      },
    ]),
  ),
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

const snapshot = async (projectRoots: string[], agentDirectory: string) => {
  const projects = await Promise.all(
    projectRoots.map(async (projectRoot) => {
      const directory = eventDirectory(projectRoot);
      const names = await listEventNames(directory);

      const events = await Promise.all(
        names.map(async (name) => [name, await readFile(join(directory, name), 'utf8')] as const),
      );

      return { projectRoot, events };
    }),
  );

  return { projects, index: await readOptional(sweepIndexPath(agentDirectory)) };
};

it('reads events from every project root in the index', async () => {
  const first = await createProject();
  const second = await createProject();
  const agentDirectory = createAgentDirectory();
  const firstEvent = correction('correction-first', '2026-11-15T12:00:00.000Z');
  const secondEvent = correction('correction-second', '2026-11-15T12:01:00.000Z');

  await writeEvent(first, firstEvent);
  await writeEvent(second, secondEvent);
  await writeSweepIndex(agentDirectory, indexFor([first, second]));

  const sources = await readCorrectSources({ agentDirectory, cwd: first });

  expect(sources.events).toHaveLength(2);
  expect(sources.events).toEqual(expect.arrayContaining([firstEvent, secondEvent]));
  expect(sources.unknownProjects).toEqual([]);
});

it('adds the current project root when the index is missing', async () => {
  const project = await createProject();
  const agentDirectory = createAgentDirectory();
  const event = correction('correction-1', '2026-11-15T12:00:00.000Z');

  await writeEvent(project, event);

  const sources = await readCorrectSources({ agentDirectory, cwd: project });

  expect(sources.events).toEqual([event]);
  expect(sources.unknownProjects).toEqual([]);
});

it('reports a project whose events cannot be read as unknown', async () => {
  const first = await createProject();
  const second = await createProject();
  const agentDirectory = createAgentDirectory();
  const firstEvent = correction('correction-first', '2026-11-15T12:00:00.000Z');

  await writeEvent(first, firstEvent);
  await mkdir(eventDirectory(second), { recursive: true });
  await writeFile(join(eventDirectory(second), 'broken.json'), '{');
  await writeSweepIndex(agentDirectory, indexFor([first, second]));

  const sources = await readCorrectSources({ agentDirectory, cwd: first });

  expect(sources.unknownProjects).toEqual([second]);
  expect(sources.events).toEqual([firstEvent]);
});

it('returns no events when no project root is known', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-outside-');
  const agentDirectory = createAgentDirectory();

  const sources = await readCorrectSources({ agentDirectory, cwd: directory });

  expect(sources).toEqual({ projects: [], events: [], unknownProjects: [], skipped: [] });
});

it('writes nothing while reading', async () => {
  const first = await createProject();
  const second = await createProject();
  const agentDirectory = createAgentDirectory();

  await writeEvent(first, correction('correction-first', '2026-11-15T12:00:00.000Z'));
  await writeEvent(second, correction('correction-second', '2026-11-15T12:01:00.000Z'));
  await writeSweepIndex(agentDirectory, indexFor([first, second]));

  const before = await snapshot([first, second], agentDirectory);

  await readCorrectSources({ agentDirectory, cwd: first });

  expect(await snapshot([first, second], agentDirectory)).toEqual(before);
});
