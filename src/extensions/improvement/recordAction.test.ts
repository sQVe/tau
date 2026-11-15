import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTemporaryBareRoot,
  createTemporaryRepository,
  git,
} from '../../../tests/gitRepository.js';
import { parseEvent } from '../../improvement/event.js';
import { recordCorrection } from './recordAction.js';
import type { CorrectionFacts } from './recordAction.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const factsFor = (cwd: string, overrides: Partial<CorrectionFacts> = {}): CorrectionFacts => ({
  cwd,
  sessionId: 'session-1',
  sessionFile: undefined,
  toolCallId: 'call|1',
  summary: 'The user said to run tests through run_tests.',
  createdAt: '2026-11-15T12:00:00.000Z',
  ...overrides,
});

const readEventFiles = async (projectRoot: string) => {
  const directory = join(projectRoot, '.tau', 'improvement');
  const names = await readdir(directory);

  return Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);

      return parseEvent(path, await readFile(path, 'utf8'));
    }),
  );
};

describe('recordCorrection', () => {
  it('saves events from a linked worktree and the bare root in one project root', async () => {
    const root = await createTemporaryBareRoot((cleanup) => cleanups.push(cleanup));
    await git(root, 'worktree', 'add', '--quiet', '--orphan', 'main');
    const projectRoot = await realpath(root);

    const fromWorktree = await recordCorrection(
      factsFor(join(root, 'main'), { toolCallId: 'call-worktree' }),
    );

    const fromBareRoot = await recordCorrection(factsFor(root, { toolCallId: 'call-root' }));
    const events = await readEventFiles(projectRoot);

    expect([fromWorktree.path, fromBareRoot.path].toSorted()).toEqual(
      [fromWorktree.id, fromBareRoot.id]
        .map((id) => join(projectRoot, '.tau', 'improvement', `${id}.json`))
        .toSorted(),
    );

    expect(
      events
        .map((event) => ({ version: event.version, kind: event.kind, id: event.id }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(
      [fromWorktree.id, fromBareRoot.id]
        .toSorted()
        .map((id) => ({ version: 1, kind: 'correction', id })),
    );
  });

  it('keeps one event file when the same tool call records twice', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    const first = await recordCorrection(factsFor(root));

    const second = await recordCorrection(
      factsFor(root, { summary: 'A retry of the same call.', createdAt: '2026-11-15T12:01:00Z' }),
    );

    const events = await readEventFiles(await realpath(root));

    expect({
      first: first.outcome,
      second: second.outcome,
      sameId: first.id === second.id,
    }).toEqual({ first: 'saved', second: 'existing', sameId: true });

    expect(events.map((event) => event.kind === 'correction' && event.summary)).toEqual([
      'The user said to run tests through run_tests.',
    ]);
  });

  it('points at the transcript when the session is saved', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    await recordCorrection(factsFor(root, { sessionFile: '/sessions/one.jsonl' }));
    const [event] = await readEventFiles(await realpath(root));

    expect(event?.evidence).toEqual([
      { kind: 'transcript', path: '/sessions/one.jsonl', toolCallId: 'call|1' },
    ]);
  });

  it('points at the session ID when no transcript is saved', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    await recordCorrection(factsFor(root));
    const [event] = await readEventFiles(await realpath(root));

    expect(event?.evidence).toEqual([
      { kind: 'session', sessionId: 'session-1', toolCallId: 'call|1' },
    ]);
  });

  it('gives different tool calls in one session different event IDs', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    const first = await recordCorrection(factsFor(root, { toolCallId: 'a' }));
    const second = await recordCorrection(factsFor(root, { toolCallId: 'b' }));

    expect(first.id).not.toBe(second.id);
  });
});
