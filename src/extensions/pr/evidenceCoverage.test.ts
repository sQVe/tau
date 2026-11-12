import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { githubOrigin, serveGithubOriginFrom } from '../../../tests/githubOriginFake.js';
import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { createGhFake } from '../../../tests/prGhFake.js';
import { repositorySnapshot } from '../../../tests/repositorySnapshotHarness.js';
import { createSavedFix, createSavedReview, savedReviewLink } from '../../../tests/savedReview.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../tests/toolContext.js';
import type { CoverageLinkRequest } from '../../reviewCapture/coverage.js';
import { readPublicationEvidence } from './evidence.js';
import type { PublicationRequest } from './evidence.js';
import { createPrTool } from './tool.js';
import type { PrInput } from './tool.js';

const commitFeature = async (root: string, text: string) => {
  await writeFile(join(root, 'feature.txt'), text);
  await git(root, 'add', 'feature.txt');
  await git(root, 'commit', '--quiet', '-m', 'change feature');

  return git(root, 'rev-parse', 'HEAD');
};

const setUp = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const remote = temporaryDirectory(onTestFinished, 'tau-pr-coverage-');

  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await serveGithubOriginFrom(remote, onTestFinished);
  await git(root, 'remote', 'add', 'origin', githubOrigin);

  const mergeBase = await commitFeature(root, 'one\n');

  await git(root, 'push', '--quiet', 'origin', 'main');
  await git(root, 'checkout', '--quiet', '-b', 'feature');

  const reviewed = await commitFeature(root, 'two\n');
  const review = await createSavedReview(root, { kind: 'range', from: mergeBase, to: reviewed });

  await writeFile(join(review, 'reviewer.md'), 'No findings.\n');

  await writeFile(join(root, 'feature.txt'), 'three\n');
  const fix = await createSavedFix(root, review, ['feature.txt']);

  await commitFeature(root, 'three\n');

  const fake = createGhFake();

  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-pr-coverage-agent-');

  const config = {
    location: { cwd: root, agentDirectory, projectTrusted: true },
    ui: { notify: () => undefined },
  };

  const chain = [await savedReviewLink(root, review), await savedReviewLink(root, fix)];

  const run = (request: PublicationRequest) =>
    readPublicationEvidence(
      { exec: fake.exec, cwd: root, signal: undefined },
      root,
      request,
      config,
    );

  const runTool = async (input: Omit<PrInput, 'action'>) => {
    const tool = createPrTool(fake.exec, { agentDirectory });
    const context = { ...noUiContext(root), isProjectTrusted: () => true };

    const result = await tool.execute(
      'call',
      { action: 'evidence', ...input },
      undefined,
      undefined,
      context,
    );

    return result.details;
  };

  return { root, review, fix, mergeBase, chain, run, runTool };
};

const runCoverage = async (root: string, chain: CoverageLinkRequest[], mergeBase: string) => {
  const tool = createPrTool(createGhFake().exec);

  const result = await tool.execute(
    'call',
    { action: 'coverage', chain, mergeBase },
    undefined,
    undefined,
    noUiContext(root),
  );

  return result.details;
};

it('selects the review chain and reads its coverage without a chain from the caller', async () => {
  const { chain, runTool } = await setUp();

  const evidence = await runTool({ remote: 'origin' });

  expect(evidence).toMatchObject({ chain, coverage: { status: 'match' } });
});

it('reports coverage next to reuse and keeps the review freshness stale', async () => {
  const { review, run } = await setUp();

  const evidence = await run({ remote: 'origin', review });

  expect(evidence.coverage).toMatchObject({ status: 'match' });
  expect(evidence.reuse).toMatchObject({ status: 'mismatch' });
  expect(evidence.review?.freshness).toMatchObject({ status: 'stale' });
  expect(evidence.gaps).not.toContainEqual(expect.objectContaining({ kind: 'coverageMismatch' }));
});

it('returns no chain and no coverage when no review has worker reports', async () => {
  const { review, run } = await setUp();

  await rm(join(review, 'reviewer.md'));

  const evidence = await run({ remote: 'origin', review });

  expect(evidence.chain).toBeNull();
  expect(evidence.coverage).toBeNull();
  expect(evidence.review).toMatchObject({ target: { kind: 'range' } });

  expect(evidence.gaps).toContainEqual({
    kind: 'reviewChain',
    gap: { kind: 'unknownReview', review },
  });
});

it('returns an ambiguous chain as a gap until review names one candidate', async () => {
  const { root, review, fix, mergeBase, chain, run } = await setUp();
  const head = await git(root, 'rev-parse', 'HEAD');
  const second = await createSavedReview(root, { kind: 'range', from: mergeBase, to: head });

  await writeFile(join(second, 'reviewer.md'), 'No findings.\n');

  const ambiguous = await run({ remote: 'origin' });
  const selected = await run({ remote: 'origin', review: fix });

  expect(ambiguous.chain).toBeNull();
  expect(ambiguous.coverage).toBeNull();

  expect(ambiguous.gaps).toContainEqual({
    kind: 'reviewChain',
    gap: {
      kind: 'ambiguousChain',
      candidates: expect.arrayContaining([[review, fix], [second]]) as unknown,
    },
  });

  expect(selected.chain).toEqual(chain);
  expect(selected.review).toMatchObject({ target: { kind: 'range' } });
  expect(selected.reuse).toMatchObject({ reports: ['reviewer.md'] });
  expect(selected.gaps).not.toContainEqual(expect.objectContaining({ kind: 'reviewChain' }));
});

it('reports a malformed capture in another review and keeps the other evidence', async () => {
  const { root, chain, run } = await setUp();
  const broken = join(root, '.tau', 'workers', 'review-broken');

  await mkdir(broken);
  await writeFile(join(broken, 'capture.json'), '{');

  const evidence = await run({ remote: 'origin' });

  expect(evidence.gaps).toContainEqual({
    kind: 'reviewChain',
    gap: { kind: 'malformedCapture', directory: broken, reason: expect.any(String) as unknown },
  });

  expect(evidence).toMatchObject({
    chain,
    coverage: { status: 'match' },
    review: { target: { kind: 'range' } },
    branch: 'feature',
    subjects: ['change feature', 'change feature'],
  });
});

it('reports a coverage mismatch as a gap with its status and reasons', async () => {
  const { root, run } = await setUp();

  await writeFile(join(root, 'other.txt'), 'other\n');
  await git(root, 'add', 'other.txt');
  await git(root, 'commit', '--quiet', '-m', 'after the fix');

  const evidence = await run({ remote: 'origin' });

  expect(evidence.coverage).toMatchObject({ status: 'mismatch', link: 2 });

  expect(evidence.gaps).toContainEqual({
    kind: 'coverageMismatch',
    status: 'mismatch',
    reasons: expect.any(Array) as unknown,
  });
});

it('changes no review file, ref, or index when coverage and evidence read a chain', async () => {
  const { root, review, fix, mergeBase, chain, run } = await setUp();
  const directories = [review, fix];
  const before = await repositorySnapshot(root, directories);

  await runCoverage(root, chain, mergeBase);
  await run({ remote: 'origin' });

  expect(await repositorySnapshot(root, directories)).toEqual(before);
});

it('reports a failed chain selection as a gap with no chain and no coverage', async () => {
  const { root, run } = await setUp();

  const evidence = await run({ remote: 'origin', review: join(root, 'review-outside') });

  expect(evidence.chain).toBeNull();
  expect(evidence.coverage).toBeNull();

  expect(evidence.gaps).toContainEqual({
    kind: 'chain',
    reason: expect.stringContaining('.tau/workers') as unknown,
  });
});
