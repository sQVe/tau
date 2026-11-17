import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.ts';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { isMissingFile } from '../errors.ts';
import {
  correctEventOwners,
  correctEvents,
  correctFailed,
  correctIndexProblem,
  correctProjectRoots,
  readCorrectSources,
} from './correctSources.ts';
import { writeEvent } from './event.ts';
import type { ImprovementEvent } from './event.ts';
import { sweepIndexPath, writeSweepIndex } from './sweepIndex.ts';
import type { SweepIndex } from './sweepIndex.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const cleanupTasks = cleanups.splice(0).map((cleanup) => cleanup());
  await Promise.all(cleanupTasks);
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

  expect(correctEvents(sources)).toHaveLength(2);
  expect(correctEvents(sources)).toEqual(expect.arrayContaining([firstEvent, secondEvent]));
  expect(correctFailed(sources)).toEqual([]);
  expect(correctProjectRoots(sources)).toEqual([first, second].toSorted());

  expect(correctEventOwners(sources)).toEqual(
    expect.arrayContaining([
      { id: firstEvent.id, projectRoot: first },
      { id: secondEvent.id, projectRoot: second },
    ]),
  );
});

it('adds the current project root when the index is missing', async () => {
  const project = await createProject();
  const agentDirectory = createAgentDirectory();
  const event = correction('correction-1', '2026-11-15T12:00:00.000Z');

  await writeEvent(project, event);

  const sources = await readCorrectSources({ agentDirectory, cwd: project });

  expect(correctEvents(sources)).toEqual([event]);
  expect(correctFailed(sources)).toEqual([]);
  expect(correctProjectRoots(sources)).toEqual([project]);
  expect(correctEventOwners(sources)).toEqual([{ id: event.id, projectRoot: project }]);
});

it('reports a project whose event directory cannot be listed as unknown', async () => {
  const first = await createProject();
  const second = await createProject();
  const agentDirectory = createAgentDirectory();
  const firstEvent = correction('correction-first', '2026-11-15T12:00:00.000Z');

  await writeEvent(first, firstEvent);
  await mkdir(join(second, '.tau'), { recursive: true });
  await writeFile(eventDirectory(second), 'not a directory');
  await writeSweepIndex(agentDirectory, indexFor([first, second]));

  const sources = await readCorrectSources({ agentDirectory, cwd: first });

  const failed = correctFailed(sources);

  expect(failed.map(({ projectRoot }) => projectRoot)).toEqual([second]);
  expect(failed[0]?.reason).toContain(eventDirectory(second));
  expect(correctEvents(sources)).toEqual([firstEvent]);
  expect(correctProjectRoots(sources)).toEqual([first]);
  expect(correctEventOwners(sources)).toEqual([{ id: firstEvent.id, projectRoot: first }]);
});

it('returns no events when no project root is known', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-outside-');
  const agentDirectory = createAgentDirectory();

  const sources = await readCorrectSources({ agentDirectory, cwd: directory });

  expect(sources).toEqual({ projects: [], indexProblem: null });
});

it('reports a malformed index and reads the current root', async () => {
  const project = await createProject();
  const agentDirectory = createAgentDirectory();
  const event = correction('correction-1', '2026-11-15T12:00:00.000Z');
  const path = sweepIndexPath(agentDirectory);

  await writeEvent(project, event);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'not JSON');

  const sources = await readCorrectSources({ agentDirectory, cwd: project });

  expect(correctIndexProblem(sources)).toContain(path);
  expect(correctEvents(sources)).toEqual([event]);
  expect(correctProjectRoots(sources)).toEqual([project]);
});

it('reports a newer index and reads the current root', async () => {
  const project = await createProject();
  const agentDirectory = createAgentDirectory();
  const event = correction('correction-1', '2026-11-15T12:00:00.000Z');
  const path = sweepIndexPath(agentDirectory);

  await writeEvent(project, event);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 2 }));

  const sources = await readCorrectSources({ agentDirectory, cwd: project });

  expect(correctIndexProblem(sources)).toContain(path);
  expect(correctEvents(sources)).toEqual([event]);
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
