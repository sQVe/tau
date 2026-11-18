import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { classEventId } from '../../improvement/classIdentity.js';
import { eventDirectory, parseEvent } from '../../improvement/event.js';
import { recordClass, recordClassDecision } from './recordClass.js';
import type { ClassDecisionFacts, ClassFacts } from './recordClass.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const cleanupTasks = cleanups.splice(0).map((cleanup) => cleanup());
  await Promise.all(cleanupTasks);
});

const createProject = async () =>
  realpath(await createTemporaryRepository((cleanup) => cleanups.push(cleanup)));

const sessionFacts = {
  sessionId: 'session-1',
  sessionFile: undefined,
  toolCallId: 'call|class',
  createdAt: '2026-11-15T12:00:00.000Z',
};

const classFactsFor = (projectRoot: string, overrides: Partial<ClassFacts> = {}): ClassFacts => ({
  ...sessionFacts,
  cwd: projectRoot,
  projectRoot,
  identity: 'lint-await',
  level: 'lint',
  summary: 'The await keyword was missing before an async call.',
  occurrences: ['correction-1', 'correction-2'],
  ...overrides,
});

it('writes a class event with the class ID', async () => {
  const project = await createProject();
  const facts = classFactsFor(project);

  const result = await recordClass(facts);
  const id = classEventId(facts.identity, facts.occurrences);

  expect(result.id).toBe(id);
  expect(result.outcome).toBe('saved');
  expect(basename(result.path)).toBe(`${id}.json`);
  expect(basename(result.path)).toMatch(/^class-lint-await-[0-9a-f]{16}\.json$/u);

  expect(parseEvent(result.path, await readFile(result.path, 'utf8'))).toMatchObject({
    version: 2,
    id,
    kind: 'class',
    identity: facts.identity,
    level: facts.level,
    summary: facts.summary,
    occurrences: facts.occurrences,
  });
});

it('writes a class event to the named project root, not the session cwd', async () => {
  const session = await createProject();
  const owning = await createProject();
  const facts = classFactsFor(owning, { cwd: session });

  const result = await recordClass(facts);

  expect(result.path).toBe(join(eventDirectory(owning), `${result.id}.json`));
  expect(existsSync(eventDirectory(session))).toBe(false);
});

it('refuses a class decision without its class event', async () => {
  const project = await createProject();

  const facts: ClassDecisionFacts = {
    ...sessionFacts,
    cwd: project,
    projectRoot: project,
    class: 'class-lint-await-0123456789abcdef',
    choice: 'approved',
  };

  const failure = await recordClassDecision(facts).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain(facts.class);
  expect(existsSync(join(project, '.tau', 'improvement'))).toBe(false);
});

it('refuses a class decision when the class event is malformed', async () => {
  const project = await createProject();
  const id = classEventId('lint-await', ['correction-1', 'correction-2']);
  const path = join(eventDirectory(project), `${id}.json`);

  await mkdir(eventDirectory(project), { recursive: true });
  await writeFile(path, '{');

  const failure = await recordClassDecision({
    ...sessionFacts,
    cwd: project,
    projectRoot: project,
    class: id,
    choice: 'approved',
  }).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain(path);
  expect(await readdir(eventDirectory(project))).toEqual([`${id}.json`]);
});

it('refuses a class decision when the class event has a newer format', async () => {
  const project = await createProject();
  const id = classEventId('lint-await', ['correction-1', 'correction-2']);
  const path = join(eventDirectory(project), `${id}.json`);

  await mkdir(eventDirectory(project), { recursive: true });
  await writeFile(path, '{"version":3}');

  const failure = await recordClassDecision({
    ...sessionFacts,
    cwd: project,
    projectRoot: project,
    class: id,
    choice: 'approved',
  }).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain(path);
  expect(failure).toContain('newer format');
  expect(await readdir(eventDirectory(project))).toEqual([`${id}.json`]);
});
