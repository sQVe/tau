import { expect, it, onTestFinished } from 'vitest';

import {
  dryRunPullRequest,
  dryRunPullRequestEdit,
  preparePublicationRun as prepareRun,
  publicationRepository as repository,
  setUpPublication,
  writeRunFile,
} from '../fixtures/publicationRun.js';
import type { PublishRequest } from './publishPlan.js';
import { planPublication, publicationTarget } from './publishPlan.js';

const setUp = () => setUpPublication(onTestFinished);

const planned = async (request: PublishRequest, files: Record<string, string> = {}) => {
  const { root, run } = await setUp();
  const directory = await prepareRun(run);

  for (const [file, contents] of Object.entries(files)) {
    await writeRunFile(directory, file, contents);
  }

  const target = await publicationTarget('dryRun', root, { ...request, directory });

  return planPublication(target);
};

const pullRequestFiles = { 'title.md': 'Add a feature\n', 'body.md': 'Adds it.\n' };

const filePathAt = (
  plan: Awaited<ReturnType<typeof planPublication>>,
  index: number,
): string | undefined => plan.commandArguments[index];

it('marks the body file of a create command', async () => {
  const plan = await planned(dryRunPullRequest('/run/1'), pullRequestFiles);

  expect(plan.fileArguments).toHaveLength(1);
  expect(plan.fileArguments[0]?.file.file).toBe('body.md');
  expect(filePathAt(plan, plan.fileArguments[0]?.index ?? -1)).toMatch(/body\.md$/u);
});

it('marks the body file of an edit command', async () => {
  const plan = await planned(dryRunPullRequestEdit('/run/1'), pullRequestFiles);

  expect(plan.fileArguments).toHaveLength(1);
  expect(plan.fileArguments[0]?.file.file).toBe('body.md');
  expect(filePathAt(plan, plan.fileArguments[0]?.index ?? -1)).toMatch(/body\.md$/u);
});

it('marks the comment file of a comment command', async () => {
  const plan = await planned(
    { kind: 'comment', repository, pr: 7, file: 'comment.md' },
    { 'comment.md': 'Looks good.\n' },
  );

  expect(plan.fileArguments).toHaveLength(1);
  expect(plan.fileArguments[0]?.file.file).toBe('comment.md');
  expect(filePathAt(plan, plan.fileArguments[0]?.index ?? -1)).toMatch(/comment\.md$/u);
});

it('marks the review file of a review command', async () => {
  const plan = await planned(
    { kind: 'review', repository, pr: 7 },
    {
      'review.json': `${JSON.stringify({ comments: [{ path: 'src/a.ts', line: 3, body: 'Fine.' }] })}\n`,
    },
  );

  expect(plan.fileArguments).toHaveLength(1);
  expect(plan.fileArguments[0]?.file.file).toBe('review.json');
  expect(filePathAt(plan, plan.fileArguments[0]?.index ?? -1)).toMatch(/review\.json$/u);
});

it('does not mistake a flag-like base for the body file', async () => {
  const plan = await planned(
    { ...dryRunPullRequest('/run/1'), base: '--body-file' },
    pullRequestFiles,
  );

  expect(plan.fileArguments).toHaveLength(1);

  const [fileArgument] = plan.fileArguments;

  expect(filePathAt(plan, fileArgument?.index ?? -1)).toBe(fileArgument?.file.path);
});

it('does not mistake a flag-like title for the body file', async () => {
  const plan = await planned(dryRunPullRequest('/run/1'), {
    ...pullRequestFiles,
    'title.md': '--body-file\n',
  });

  expect(plan.fileArguments).toHaveLength(1);

  const [fileArgument] = plan.fileArguments;

  expect(filePathAt(plan, fileArgument?.index ?? -1)).toBe(fileArgument?.file.path);
});

it('returns prose findings for the dry run and none for publish', async () => {
  const { root, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it \u2014 now.\n');
  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = { ...dryRunPullRequest(directory) };

  const dryRunPlan = await planPublication(await publicationTarget('dryRun', root, request));
  const publishPlan = await planPublication(await publicationTarget('publish', root, request));

  expect(dryRunPlan.findings).toHaveLength(1);
  expect(publishPlan.findings).toEqual([]);
});
