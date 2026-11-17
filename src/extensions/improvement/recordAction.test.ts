import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTemporaryBareRoot,
  createTemporaryRepository,
  git,
} from '../../../tests/gitRepository.js';
import { parseEvent, writeEvent } from '../../improvement/event.js';
import {
  recordBacklog,
  recordCorrection,
  recordDecision,
  recordReview,
  runRecord,
} from './recordAction.js';
import type { BacklogFacts, CorrectionFacts, DecisionFacts, ReviewFacts } from './recordAction.js';

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

const reviewFactsFor = (cwd: string, overrides: Partial<ReviewFacts> = {}): ReviewFacts => ({
  cwd,
  projectRoot: cwd,
  sessionId: 'session-1',
  sessionFile: undefined,
  toolCallId: 'call|review',
  pullRequest: 'https://github.com/example/repo/pull/1',
  outcome: 'The task passed.',
  createdAt: '2026-11-15T12:00:00.000Z',
  ...overrides,
});

const backlogFactsFor = (cwd: string, overrides: Partial<BacklogFacts> = {}): BacklogFacts => ({
  cwd,
  projectRoot: cwd,
  sessionId: 'session-1',
  sessionFile: undefined,
  toolCallId: 'call|backlog',
  review: 'review-1',
  item: 1,
  summary: 'Split the module.',
  createdAt: '2026-11-15T12:00:00.000Z',
  ...overrides,
});

const decisionFactsFor = (cwd: string, overrides: Partial<DecisionFacts> = {}): DecisionFacts => ({
  cwd,
  projectRoot: cwd,
  sessionId: 'session-1',
  sessionFile: undefined,
  toolCallId: 'call|decision',
  review: 'review-1',
  item: 1,
  choice: 'approved',
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

describe('recordReview', () => {
  it('saves a review in the reviewed task project, not the session project', async () => {
    const sessionRoot = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const taskRoot = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const taskProjectRoot = await realpath(taskRoot);

    const saved = await recordReview(reviewFactsFor(sessionRoot, { projectRoot: taskRoot }));

    expect(saved.path).toBe(join(taskProjectRoot, '.tau', 'improvement', `${saved.id}.json`));
    expect(existsSync(join(taskProjectRoot, '.tau', 'improvement'))).toBe(true);
    expect(existsSync(join(await realpath(sessionRoot), '.tau', 'improvement'))).toBe(false);
  });

  it('records a review after the task worktree was removed', async () => {
    const root = await createTemporaryBareRoot((cleanup) => cleanups.push(cleanup));
    await git(root, 'worktree', 'add', '--quiet', '--orphan', 'main');
    const projectRoot = await realpath(root);
    await git(root, 'worktree', 'remove', '--force', 'main');

    const sessionRoot = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const saved = await recordReview(reviewFactsFor(sessionRoot, { projectRoot }));

    expect(saved.path).toBe(join(projectRoot, '.tau', 'improvement', `${saved.id}.json`));
    expect(existsSync(join(projectRoot, '.tau', 'improvement'))).toBe(true);
    expect(existsSync(join(await realpath(sessionRoot), '.tau', 'improvement'))).toBe(false);
  });

  it('saves a review event with its pull request and keeps it on retry', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    const first = await recordReview(reviewFactsFor(root));

    const second = await recordReview(
      reviewFactsFor(root, { outcome: 'A retry.', createdAt: '2026-11-15T12:01:00.000Z' }),
    );

    const events = await readEventFiles(await realpath(root));

    expect({
      first: first.outcome,
      second: second.outcome,
      sameId: first.id === second.id,
    }).toEqual({ first: 'saved', second: 'existing', sameId: true });

    expect(first.id).toMatch(/^review-[0-9a-f]{32}$/u);

    expect(
      events.map(
        (event) =>
          event.kind === 'review' && {
            pullRequest: event.pullRequest,
            outcome: event.outcome,
            evidence: event.evidence,
          },
      ),
    ).toEqual([
      {
        pullRequest: 'https://github.com/example/repo/pull/1',
        outcome: 'The task passed.',
        evidence: [
          { kind: 'session', sessionId: 'session-1', toolCallId: 'call|review' },
          { kind: 'pullRequest', url: 'https://github.com/example/repo/pull/1' },
        ],
      },
    ]);
  });
});

describe('recordDecision', () => {
  it('finds the review in the reviewed task project', async () => {
    const sessionRoot = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const taskRoot = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const taskProjectRoot = await realpath(taskRoot);

    const review = await recordReview(reviewFactsFor(sessionRoot, { projectRoot: taskRoot }));

    const saved = await recordDecision(
      decisionFactsFor(sessionRoot, { projectRoot: taskRoot, review: review.id, item: 2 }),
    );

    expect(saved.path).toBe(join(taskProjectRoot, '.tau', 'improvement', `${saved.id}.json`));
    expect(existsSync(join(await realpath(sessionRoot), '.tau', 'improvement'))).toBe(false);
  });

  it('saves one decision per review item and keeps the first on retry', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const review = await recordReview(reviewFactsFor(root));

    const first = await recordDecision(
      decisionFactsFor(root, { review: review.id, item: 2, choice: 'approved' }),
    );

    const second = await recordDecision(
      decisionFactsFor(root, { review: review.id, item: 2, choice: 'rejected' }),
    );

    const events = await readEventFiles(await realpath(root));

    expect({ id: first.id, first: first.outcome, second: second.outcome }).toEqual({
      id: `decision-${review.id}-2`,
      first: 'saved',
      second: 'existing',
    });

    expect(
      events
        .filter((event) => event.kind === 'decision')
        .map((event) => ({
          subject: event.subject,
          choice: event.choice,
          evidence: event.evidence,
        })),
    ).toEqual([
      {
        subject: review.id,
        choice: 'approved',
        evidence: [{ kind: 'session', sessionId: 'session-1', toolCallId: 'call|decision' }],
      },
    ]);
  });
});

describe('recordBacklog', () => {
  it('finds the review in the reviewed task project', async () => {
    const sessionRoot = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const taskRoot = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const taskProjectRoot = await realpath(taskRoot);

    const review = await recordReview(reviewFactsFor(sessionRoot, { projectRoot: taskRoot }));

    const saved = await recordBacklog(
      backlogFactsFor(sessionRoot, { projectRoot: taskRoot, review: review.id, item: 3 }),
    );

    expect(saved.path).toBe(join(taskProjectRoot, '.tau', 'improvement', `${saved.id}.json`));
    expect(existsSync(join(await realpath(sessionRoot), '.tau', 'improvement'))).toBe(false);
  });

  it("saves a backlog item with the review's pull request", async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const review = await recordReview(reviewFactsFor(root));

    const saved = await recordBacklog(
      backlogFactsFor(root, { review: review.id, item: 3, summary: 'Split the module.' }),
    );

    const events = await readEventFiles(await realpath(root));
    const backlog = events.find((event) => event.kind === 'backlog');

    expect(saved.id).toBe(`backlog-${review.id}-3`);

    expect(backlog).toMatchObject({
      summary: 'Split the module.',
      pullRequest: 'https://github.com/example/repo/pull/1',
      evidence: [
        { kind: 'session', sessionId: 'session-1', toolCallId: 'call|backlog' },
        { kind: 'pullRequest', url: 'https://github.com/example/repo/pull/1' },
      ],
    });
  });
});

it('refuses a decision or backlog item for a review that does not exist', async () => {
  const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
  const projectRoot = await realpath(root);

  await writeEvent(projectRoot, {
    version: 1,
    id: 'merge-1',
    kind: 'merge',
    createdAt: '2026-11-15T12:00:00.000Z',
    evidence: [],
    repository: 'example/repo',
    pullRequest: 'https://github.com/example/repo/pull/1',
    mergedAt: '2026-11-15T12:00:00.000Z',
  });

  const failures = [];

  for (const review of ['review-missing', 'merge-1']) {
    const expected = `No review event ${review} in ${join(projectRoot, '.tau', 'improvement')}.`;

    const decision = await recordDecision(decisionFactsFor(root, { review })).then(
      () => 'no error',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    const backlog = await recordBacklog(backlogFactsFor(root, { review })).then(
      () => 'no error',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    failures.push({ decision, backlog, expected });
  }

  expect(failures).toEqual([
    {
      decision: `No review event review-missing in ${join(projectRoot, '.tau', 'improvement')}.`,
      backlog: `No review event review-missing in ${join(projectRoot, '.tau', 'improvement')}.`,
      expected: `No review event review-missing in ${join(projectRoot, '.tau', 'improvement')}.`,
    },
    {
      decision: `No review event merge-1 in ${join(projectRoot, '.tau', 'improvement')}.`,
      backlog: `No review event merge-1 in ${join(projectRoot, '.tau', 'improvement')}.`,
      expected: `No review event merge-1 in ${join(projectRoot, '.tau', 'improvement')}.`,
    },
  ]);

  expect((await readdir(join(projectRoot, '.tau', 'improvement'))).toSorted()).toEqual([
    'merge-1.json',
  ]);
});

it('refuses a decision when an event file is damaged', async () => {
  const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
  const directory = join(await realpath(root), '.tau', 'improvement');
  const damaged = join(directory, 'review-damaged.json');

  await mkdir(directory, { recursive: true });
  await writeFile(damaged, '{not json', 'utf8');

  const failure = await recordDecision(decisionFactsFor(root, { review: 'review-damaged' })).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toContain(damaged);
});

it('refuses a decision when the named review has a newer format', async () => {
  const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
  const directory = join(await realpath(root), '.tau', 'improvement');
  const named = join(directory, 'review-newer.json');
  const other = join(directory, 'review-aaa.json');

  await mkdir(directory, { recursive: true });
  await writeFile(named, '{"version":2}', 'utf8');
  await writeFile(other, '{"version":2}', 'utf8');

  const failure = await recordDecision(decisionFactsFor(root, { review: 'review-newer' })).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failure).toBe(
    `Improvement event ${named} has a newer format than this Tau reads. Update Tau, then restart the session.`,
  );

  expect((await readdir(directory)).toSorted()).toEqual(['review-aaa.json', 'review-newer.json']);
  expect(await readFile(named, 'utf8')).toBe('{"version":2}');
  expect(await readFile(other, 'utf8')).toBe('{"version":2}');
});

describe('runRecord', () => {
  it('refuses a whitespace-only summary and saves nothing', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    const context = {
      cwd: root,
      sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => undefined },
    } as unknown as ExtensionContext;

    const failure = await runRecord(
      'call-1',
      { action: 'record', kind: 'correction', summary: ' \n\t ' },
      context,
    ).then(
      () => 'no error',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect({ failure, saved: existsSync(join(root, '.tau', 'improvement')) }).toEqual({
      failure: 'record kind correction needs a non-blank summary.',
      saved: false,
    });
  });
});
