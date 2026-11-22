import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { DecisionRecord } from '../../questionGate/decision/decisionRecord.js';
import { findSharedRepositoryRoot } from '../../tauDirectory.js';
import { createEvidenceRepository, readSavedFiles } from './fixtures/evidenceRepository.js';
import { readGateDecisions } from './gateDecisionEvidence.js';

const question = {
  question: 'Which route?',
  problem: 'The route is open.',
  impact: 'The wrong route wastes a day.',
  options: [
    { label: 'Fast', description: 'Ship now.', recommended: true },
    { label: 'Careful', description: 'Check first.', recommended: false },
  ],
};

const decisionName = (digit: string): string =>
  `decision-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}.json`;

const decisionRecord = (overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  version: 1,
  kind: 'decision',
  time: 1760000000000,
  sessionId: 'session-1',
  branch: 'feature',
  head: 'f13f17eb',
  cohort: 'c'.repeat(64),
  variant: 'classifier',
  cutoff: 0.7,
  decisions: [{ question, choice: 'Fast', reason: 'Ship now.', confidence: 0.8 }],
  ...overrides,
});

const questionsDirectory = (root: string): string => join(root, '.tau', 'questions');

const createGateRepository = async (): Promise<string> => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'initial');

  return root;
};

const readFrom = (root: string, branch: string | null) =>
  readGateDecisions(() => findSharedRepositoryRoot(root), branch);

const saveMalformedRecord = async (root: string, name: string): Promise<string> => {
  const directory = questionsDirectory(root);
  const path = join(directory, name);

  await mkdir(directory, { recursive: true });
  await writeFile(path, '{');

  return path;
};

const saveDecisionRecord = async (
  root: string,
  name: string,
  record: DecisionRecord,
): Promise<string> => {
  const directory = questionsDirectory(root);
  const path = join(directory, name);

  await mkdir(directory, { recursive: true });
  await writeFile(path, JSON.stringify(record));

  return path;
};

it('sorts the branch records by time and then path', async () => {
  const root = await createGateRepository();

  const laterPath = await saveDecisionRecord(
    root,
    decisionName('1'),
    decisionRecord({ time: 1760000002000 }),
  );

  await saveDecisionRecord(root, decisionName('3'), decisionRecord({ time: 1760000001000 }));

  const earlierPath = await saveDecisionRecord(
    root,
    decisionName('2'),
    decisionRecord({ time: 1760000001000 }),
  );

  const before = await readSavedFiles(root);
  const read = await readFrom(root, 'feature');

  expect(read.gateDecisions?.map((record) => record.path)).toEqual([
    earlierPath,
    join(questionsDirectory(root), decisionName('3')),
    laterPath,
  ]);

  expect(read.gaps).toEqual([]);
  expect(await readSavedFiles(root)).toEqual(before);
});

it('reports a gap when the decision directory cannot be read', async () => {
  const root = await createGateRepository();

  await mkdir(join(root, '.tau'), { recursive: true });
  await writeFile(questionsDirectory(root), 'not a directory');

  const before = await readSavedFiles(root);
  const read = await readFrom(root, 'feature');

  expect(read.gateDecisions).toBeNull();

  expect(read.gaps).toContainEqual({
    kind: 'gateDecision',
    reason: expect.any(String) as unknown,
  });

  expect(await readSavedFiles(root)).toEqual(before);
});

it('lists only the decision records of the current branch', async () => {
  const root = await createGateRepository();
  const featurePath = await saveDecisionRecord(root, decisionName('1'), decisionRecord());

  await saveDecisionRecord(
    root,
    decisionName('2'),
    decisionRecord({ branch: 'other', time: 1760000000001 }),
  );

  const before = await readSavedFiles(root);
  const read = await readFrom(root, 'feature');

  expect(read.gateDecisions).toEqual([
    {
      path: featurePath,
      time: 1760000000000,
      head: 'f13f17eb',
      decisions: [
        { question: 'Which route?', choice: 'Fast', reason: 'Ship now.', confidence: 0.8 },
      ],
    },
  ]);

  expect(await readSavedFiles(root)).toEqual(before);
});

it('lists none when no decision directory exists', async () => {
  const root = await createGateRepository();

  const before = await readSavedFiles(root);
  const read = await readFrom(root, 'feature');

  expect(read.gateDecisions).toEqual([]);

  expect(
    read.gaps.filter((gap) => gap.kind === 'gateDecision' || gap.kind === 'gateDecisionRecord'),
  ).toEqual([]);

  expect(await readSavedFiles(root)).toEqual(before);
});

it('reports a malformed record as a gap and keeps the valid one', async () => {
  const root = await createGateRepository();
  const validPath = await saveDecisionRecord(root, decisionName('1'), decisionRecord());
  const malformedPath = await saveMalformedRecord(root, decisionName('2'));

  const before = await readSavedFiles(root);
  const read = await readFrom(root, 'feature');

  expect(read.gateDecisions?.map((record) => record.path)).toEqual([validPath]);

  expect(read.gaps).toContainEqual({
    kind: 'gateDecisionRecord',
    path: malformedPath,
    reason: expect.any(String) as unknown,
  });

  const recordGap = read.gaps.find((gap) => gap.kind === 'gateDecisionRecord');
  const recordReason = recordGap?.kind === 'gateDecisionRecord' ? recordGap.reason : '';

  expect(recordReason).toContain(malformedPath);

  expect(await readSavedFiles(root)).toEqual(before);
});

it('reports a gap on a detached HEAD', async () => {
  const root = await createGateRepository();

  await git(root, 'checkout', '--quiet', '--detach');

  await expect(git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD')).rejects.toThrow(
    /symbolic-ref/u,
  );

  const before = await readSavedFiles(root);
  const read = await readFrom(root, null);

  expect(read.gateDecisions).toBeNull();

  expect(read.gaps).toContainEqual({
    kind: 'gateDecision',
    reason: expect.any(String) as unknown,
  });

  expect(await readSavedFiles(root)).toEqual(before);
});

it('finds records from a linked worktree', async () => {
  const root = await createGateRepository();
  const worktree = join(temporaryDirectory(onTestFinished, 'tau-gate-worktree-'), 'worktree');

  await git(root, 'worktree', 'add', '--quiet', '-b', 'worktree-feature', worktree);

  const recordPath = await saveDecisionRecord(
    root,
    decisionName('1'),
    decisionRecord({ branch: 'worktree-feature' }),
  );

  const before = await readSavedFiles(root);
  const read = await readFrom(worktree, 'worktree-feature');
  const recordPaths = read.gateDecisions?.map((record) => record.path);
  const canonicalRecordPath = await realpath(recordPath);

  expect(recordPaths).toEqual([canonicalRecordPath]);

  expect(await readSavedFiles(root)).toEqual(before);
});

it('lists the branch decisions beside the other publication evidence without writing', async () => {
  const { root, run } = await createEvidenceRepository(onTestFinished);
  const featurePath = await saveDecisionRecord(root, decisionName('1'), decisionRecord());

  await saveDecisionRecord(
    root,
    decisionName('2'),
    decisionRecord({ branch: 'other', time: 1760000000001 }),
  );

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.branch).toBe('feature');

  expect(evidence.gateDecisions).toEqual([
    {
      path: featurePath,
      time: 1760000000000,
      head: 'f13f17eb',
      decisions: [
        { question: 'Which route?', choice: 'Fast', reason: 'Ship now.', confidence: 0.8 },
      ],
    },
  ]);

  expect(evidence.review).not.toBeNull();
  expect(evidence.review?.reusable).toBe(true);

  expect(await readSavedFiles(root)).toEqual(before);
});
