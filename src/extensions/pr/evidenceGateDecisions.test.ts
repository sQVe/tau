import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { DecisionRecord } from '../../questionGate/decision/decisionRecord.js';
import { createEvidenceRepository, readSavedFiles } from './fixtures/evidenceRepository.js';

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
  const { root, run } = await createEvidenceRepository(onTestFinished);

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
  const evidence = await run();

  expect(evidence.gateDecisions?.map((record) => record.path)).toEqual([
    earlierPath,
    join(questionsDirectory(root), decisionName('3')),
    laterPath,
  ]);

  expect(await readSavedFiles(root)).toEqual(before);
});

it('reports a gap when the decision directory cannot be read', async () => {
  const { root, run } = await createEvidenceRepository(onTestFinished);

  await mkdir(join(root, '.tau'), { recursive: true });
  await writeFile(questionsDirectory(root), 'not a directory');

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.gateDecisions).toBeNull();

  expect(evidence.gaps).toContainEqual({
    kind: 'gateDecision',
    reason: expect.any(String) as unknown,
  });

  expect(await readSavedFiles(root)).toEqual(before);
});

it('lists only the decision records of the current branch', async () => {
  const { root, run } = await createEvidenceRepository(onTestFinished);
  const featurePath = await saveDecisionRecord(root, decisionName('1'), decisionRecord());

  await saveDecisionRecord(
    root,
    decisionName('2'),
    decisionRecord({ branch: 'other', time: 1760000000001 }),
  );

  const before = await readSavedFiles(root);
  const evidence = await run();

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

  expect(await readSavedFiles(root)).toEqual(before);
});

it('lists none when no decision directory exists', async () => {
  const { root, run } = await createEvidenceRepository(onTestFinished);

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.gateDecisions).toEqual([]);

  expect(
    evidence.gaps.filter((gap) => gap.kind === 'gateDecision' || gap.kind === 'gateDecisionRecord'),
  ).toEqual([]);

  expect(await readSavedFiles(root)).toEqual(before);
});

it('reports a malformed record as a gap and keeps the valid one', async () => {
  const { root, run } = await createEvidenceRepository(onTestFinished);
  const validPath = await saveDecisionRecord(root, decisionName('1'), decisionRecord());
  const malformedPath = await saveMalformedRecord(root, decisionName('2'));

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.gateDecisions?.map((record) => record.path)).toEqual([validPath]);

  expect(evidence.gaps).toContainEqual({
    kind: 'gateDecisionRecord',
    path: malformedPath,
    reason: expect.any(String) as unknown,
  });

  const recordGap = evidence.gaps.find((gap) => gap.kind === 'gateDecisionRecord');
  const recordReason = recordGap?.kind === 'gateDecisionRecord' ? recordGap.reason : '';

  expect(recordReason).toContain(malformedPath);

  expect(evidence.review?.reusable).toBe(true);
  expect(await readSavedFiles(root)).toEqual(before);
});

it('reports a gap on a detached HEAD', async () => {
  const { root, run } = await createEvidenceRepository(onTestFinished);

  await git(root, 'checkout', '--quiet', '--detach');

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.branch).toBeNull();
  expect(evidence.gateDecisions).toBeNull();

  expect(evidence.gaps).toContainEqual({
    kind: 'gateDecision',
    reason: expect.any(String) as unknown,
  });

  expect(evidence.review).not.toBeNull();
  expect(await readSavedFiles(root)).toEqual(before);
});

it('finds records from a linked worktree', async () => {
  const { root, runIn } = await createEvidenceRepository(onTestFinished);
  const worktree = join(temporaryDirectory(onTestFinished, 'tau-gate-worktree-'), 'worktree');

  await git(root, 'worktree', 'add', '--quiet', '-b', 'worktree-feature', worktree);

  const recordPath = await saveDecisionRecord(
    root,
    decisionName('1'),
    decisionRecord({ branch: 'worktree-feature' }),
  );

  const before = await readSavedFiles(root);
  const evidence = await runIn(worktree, { remote: 'origin' });
  const recordPaths = evidence.gateDecisions?.map((record) => record.path);
  const canonicalRecordPath = await realpath(recordPath);

  expect(evidence.branch).toBe('worktree-feature');

  expect(recordPaths).toEqual([canonicalRecordPath]);

  expect(await readSavedFiles(root)).toEqual(before);
});
