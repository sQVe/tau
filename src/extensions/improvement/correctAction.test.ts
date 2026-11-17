import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { classEventId } from '../../improvement/classIdentity.js';
import type { ProposedClass } from '../../improvement/correctDecision.js';
import { eventDirectory, writeEvent } from '../../improvement/event.js';
import type { ImprovementEvent } from '../../improvement/event.js';
import { writeSweepIndex } from '../../improvement/sweepIndex.js';
import type { SweepIndex } from '../../improvement/sweepIndex.js';
import { runCorrect } from './correctAction.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const createProject = async () =>
  realpath(await createTemporaryRepository((cleanup) => cleanups.push(cleanup)));

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

const classEvent = (overrides: {
  identity: string;
  occurrences: string[];
  createdAt?: string;
}): ImprovementEvent => ({
  version: 2,
  id: classEventId(overrides.identity, overrides.occurrences),
  kind: 'class',
  createdAt: overrides.createdAt ?? '2026-11-15T12:00:00.000Z',
  evidence: [],
  identity: overrides.identity,
  level: 'lint',
  summary: 'The await keyword was missing before an async call.',
  occurrences: overrides.occurrences,
});

const decisionEvent = (overrides: {
  subject: string;
  choice: 'approved' | 'rejected' | 'redirected';
  createdAt?: string;
}): ImprovementEvent => ({
  version: 2,
  id: `decision-${overrides.subject}`,
  kind: 'decision',
  createdAt: overrides.createdAt ?? '2026-11-15T12:01:00.000Z',
  evidence: [],
  subject: overrides.subject,
  choice: overrides.choice,
});

const factsEvent = (overrides: {
  id: string;
  fixCaptures: number;
  createdAt?: string;
}): ImprovementEvent => ({
  version: 2,
  id: overrides.id,
  kind: 'facts',
  createdAt: overrides.createdAt ?? '2026-11-15T12:00:00.000Z',
  evidence: [],
  pullRequest: 'https://github.com/sqve/tau/pull/562',
  facts: { fixCaptures: overrides.fixCaptures },
  coverage: 'complete',
});

const proposed = (overrides: Partial<ProposedClass> = {}): ProposedClass => ({
  identity: 'lint-a',
  level: 'lint',
  summary: 'The await keyword was missing before an async call.',
  occurrences: ['occurrence-1', 'occurrence-2'],
  reverted: false,
  qaMiss: false,
  ...overrides,
});

it('returns the ranked classes and measures', async () => {
  const project = await createProject();
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');
  const saved = classEvent({ identity: 'test-saved', occurrences: ['a', 'b'] });

  await writeEvent(project, saved);
  await writeEvent(project, decisionEvent({ subject: saved.id, choice: 'approved' }));
  await writeEvent(project, factsEvent({ id: 'facts-1', fixCaptures: 2 }));
  await writeEvent(project, factsEvent({ id: 'facts-2', fixCaptures: 3 }));

  const result = await runCorrect(agentDirectory, project, {
    action: 'correct',
    classes: [
      proposed({ identity: 'lint-a', occurrences: ['a', 'b'] }),
      proposed({ identity: 'lint-b', occurrences: ['a', 'b', 'c'] }),
    ],
  });

  expect('classes' in result ? result.classes : []).toEqual([
    {
      ...proposed({ identity: 'lint-b', occurrences: ['a', 'b', 'c'] }),
      id: classEventId('lint-b', ['a', 'b', 'c']),
      repeatCount: 3,
    },
    {
      ...proposed({ identity: 'lint-a', occurrences: ['a', 'b'] }),
      id: classEventId('lint-a', ['a', 'b']),
      repeatCount: 2,
    },
  ]);

  expect(result.measures).toEqual({
    repeatRateAfterCheck: { value: 0, coverage: 1 },
    medianFixRounds: { value: 2.5, coverage: 2 },
    acceptanceRate: { value: 1, coverage: 1 },
  });
});

it('returns the evidence, measures, and skipped notices without classes', async () => {
  const project = await createProject();
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');
  const rejected = classEvent({ identity: 'lint-rejected', occurrences: ['a', 'b'] });
  const newerPath = join(eventDirectory(project), 'newer.json');

  await writeEvent(project, rejected);
  await writeEvent(project, decisionEvent({ subject: rejected.id, choice: 'rejected' }));
  await mkdir(eventDirectory(project), { recursive: true });
  await writeFile(newerPath, '{"version":99}');

  const result = await runCorrect(agentDirectory, project, { action: 'correct' });

  expect('events' in result ? result.events : []).toEqual(
    expect.arrayContaining([rejected, expect.objectContaining({ subject: rejected.id })]),
  );

  expect('rejected' in result ? result.rejected : []).toEqual([rejected.id]);

  expect(result.measures).toEqual({
    repeatRateAfterCheck: { value: undefined, coverage: 0 },
    medianFixRounds: { value: undefined, coverage: 0 },
    acceptanceRate: { value: 0, coverage: 1 },
  });

  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]?.path).toBe(newerPath);
  expect(result.coverage).toEqual({ complete: 0, managerOnly: 0, missing: 0 });
});

it('reports a failed project and keeps the other evidence', async () => {
  const readable = await createProject();
  const malformed = await createProject();
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');
  const saved = classEvent({ identity: 'lint-readable', occurrences: ['a', 'b'] });
  const brokenPath = join(eventDirectory(malformed), 'class-broken.json');

  await writeEvent(readable, saved);
  await mkdir(eventDirectory(malformed), { recursive: true });
  await writeFile(brokenPath, '{');
  await writeSweepIndex(agentDirectory, indexFor([readable, malformed]));

  const result = await runCorrect(agentDirectory, readable, { action: 'correct' });

  expect('events' in result ? result.events : []).toEqual([saved]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]?.projectRoot).toBe(malformed);
  expect(result.failed[0]?.reason).toContain(brokenPath);
});
