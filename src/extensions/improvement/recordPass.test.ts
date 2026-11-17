import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { parseEvent } from '../../improvement/event.js';
import { writeSweepIndex } from '../../improvement/sweepIndex.js';
import type { SweepIndex } from '../../improvement/sweepIndex.js';
import type { SessionFacts } from './recordAction.js';
import { recordPass } from './recordPass.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const createProject = async () =>
  realpath(await createTemporaryRepository((cleanup) => cleanups.push(cleanup)));

const createAgentDirectory = () => temporaryDirectory(onTestFinished, 'tau-agent-');

const factsFor = (cwd: string): SessionFacts => ({
  cwd,
  sessionId: 'session-1',
  sessionFile: undefined,
  toolCallId: 'call|pass',
  createdAt: '2026-11-15T12:00:00.000Z',
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

const eventNames = (projectRoot: string) => readdir(eventDirectory(projectRoot));

it('writes a pass event to every project root', async () => {
  const first = await createProject();
  const second = await createProject();
  const agentDirectory = createAgentDirectory();

  await writeSweepIndex(agentDirectory, indexFor([first, second]));

  const result = await recordPass(agentDirectory, factsFor(first));

  expect(result.id).toMatch(/^pass-[0-9a-f]{32}$/u);
  expect(result.failed).toEqual([]);

  expect(result.paths.toSorted()).toEqual(
    [first, second].map((root) => join(eventDirectory(root), `${result.id}.json`)).toSorted(),
  );

  for (const root of [first, second]) {
    const path = join(eventDirectory(root), `${result.id}.json`);

    expect(parseEvent(path, await readFile(path, 'utf8'))).toMatchObject({
      id: result.id,
      kind: 'pass',
      pass: 'correct',
    });
  }
});

it('writes a pass event to the current root when the index lists another project', async () => {
  const indexed = await createProject();
  const current = await createProject();
  const agentDirectory = createAgentDirectory();

  await writeSweepIndex(agentDirectory, indexFor([indexed]));

  const result = await recordPass(agentDirectory, factsFor(current));

  expect(result.failed).toEqual([]);

  expect(result.paths.toSorted()).toEqual(
    [indexed, current].map((root) => join(eventDirectory(root), `${result.id}.json`)).toSorted(),
  );
});

it('writes a pass event to the indexed roots from a cwd outside Git', async () => {
  const indexed = await createProject();
  const agentDirectory = createAgentDirectory();
  const outside = temporaryDirectory(onTestFinished, 'tau-outside-');

  await writeSweepIndex(agentDirectory, indexFor([indexed]));

  const result = await recordPass(agentDirectory, factsFor(outside));

  expect(result.failed).toEqual([]);
  expect(result.paths).toEqual([join(eventDirectory(indexed), `${result.id}.json`)]);
});

it('refuses a pass with no project root to write to', async () => {
  const agentDirectory = createAgentDirectory();
  const outside = temporaryDirectory(onTestFinished, 'tau-outside-');

  await expect(recordPass(agentDirectory, factsFor(outside))).rejects.toThrow(
    `No project root to record the pass in from ${outside}.`,
  );
});

it('writes a pass event to the current root when the index is missing', async () => {
  const project = await createProject();
  const agentDirectory = createAgentDirectory();

  const result = await recordPass(agentDirectory, factsFor(project));

  expect(result.failed).toEqual([]);
  expect(result.paths).toEqual([join(eventDirectory(project), `${result.id}.json`)]);
  expect(await eventNames(project)).toEqual([`${result.id}.json`]);
});

it('reports a failed pass root and retries only it', async () => {
  const first = await createProject();
  const second = await createProject();
  const agentDirectory = createAgentDirectory();
  const failedRoot = join(second, '.tau');

  await writeSweepIndex(agentDirectory, indexFor([first, second]));
  await writeFile(failedRoot, 'not a directory');

  const firstCall = await recordPass(agentDirectory, factsFor(first));

  expect(firstCall.failed.map(({ projectRoot }) => projectRoot)).toEqual([second]);
  expect(firstCall.paths).toEqual([join(eventDirectory(first), `${firstCall.id}.json`)]);

  const sentinel = 'keep the first root';
  await writeFile(join(eventDirectory(first), `${firstCall.id}.json`), sentinel);

  await rm(failedRoot);
  await mkdir(failedRoot, { recursive: true });

  const retry = await recordPass(agentDirectory, factsFor(first));

  expect(retry.failed).toEqual([]);
  expect(retry.paths).toEqual([join(eventDirectory(second), `${retry.id}.json`)]);

  expect(await readFile(join(eventDirectory(first), `${firstCall.id}.json`), 'utf8')).toBe(
    sentinel,
  );
});
