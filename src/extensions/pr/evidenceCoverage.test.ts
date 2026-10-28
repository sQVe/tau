import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { githubOrigin, serveGithubOriginFrom } from '../../../tests/githubOriginFake.js';
import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { repositorySnapshot } from '../../../tests/repositorySnapshotHarness.js';
import { createSavedFix, createSavedReview, savedReviewLink } from '../../../tests/savedReview.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../tests/toolContext.js';
import type { CoverageLinkRequest } from '../../reviewCapture/coverage.js';
import { readPublicationEvidence } from './evidence.js';
import type { PublicationRequest } from './evidence.js';
import { createGhFake } from './fixtures/ghFake.js';
import { createPrTool } from './tool.js';

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

  return { root, review, fix, mergeBase, chain, run };
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

it('reports coverage next to reuse and keeps the review freshness stale', async () => {
  const { review, chain, run } = await setUp();

  const evidence = await run({ remote: 'origin', review, chain });

  expect(evidence.coverage).toMatchObject({ status: 'match' });
  expect(evidence.reuse).toMatchObject({ status: 'mismatch' });
  expect(evidence.review?.freshness).toMatchObject({ status: 'stale' });
  expect(evidence.gaps).not.toContainEqual(expect.objectContaining({ kind: 'coverageMismatch' }));
});

it('adds no coverage field without a chain', async () => {
  const { review, run } = await setUp();

  const evidence = await run({ remote: 'origin', review });

  expect(evidence).not.toHaveProperty('coverage');
  expect(evidence.gaps).not.toContainEqual(expect.objectContaining({ kind: 'coverageMismatch' }));
});

it('reports a coverage mismatch as a gap with its status and reasons', async () => {
  const { root, chain, run } = await setUp();

  await writeFile(join(root, 'other.txt'), 'other\n');
  await git(root, 'add', 'other.txt');
  await git(root, 'commit', '--quiet', '-m', 'after the fix');

  const evidence = await run({ remote: 'origin', chain });

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
  await run({ remote: 'origin', chain });

  expect(await repositorySnapshot(root, directories)).toEqual(before);
});

it('reports a coverage read error as a gap with no coverage result', async () => {
  const { root, run } = await setUp();
  const outside = [{ directory: join(root, 'review-outside'), identity: 'unused' }];

  const evidence = await run({ remote: 'origin', chain: outside });

  expect(evidence.coverage).toBeNull();

  expect(evidence.gaps).toContainEqual({
    kind: 'coverage',
    reason: expect.stringContaining('.tau/workers') as unknown,
  });
});
