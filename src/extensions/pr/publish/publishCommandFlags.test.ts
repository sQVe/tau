import { expect, it, onTestFinished } from 'vitest';

import {
  dryRunPullRequest,
  dryRunPullRequestEdit,
  preparePublicationRun as prepareRun,
  publicationRepository as repository,
  setUpPublication,
  writeRunFile,
} from '../fixtures/publicationRun.js';
import type { PrInput } from '../tool.js';
import { commandFlags, flagKind } from './publishExecution.js';

const setUp = () => setUpPublication(onTestFinished);

const publishedFlags = async (
  files: Record<string, string>,
  request: (directory: string) => PrInput & { action: 'dryRun' },
): Promise<string[]> => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  for (const [file, contents] of Object.entries(files)) {
    await writeRunFile(directory, file, contents);
  }

  const dryRun = await run(request(directory));

  await run({ ...request(directory), action: 'publish', token: dryRun.token });

  return commandFlags(fake.calls[0]?.commandArguments ?? []);
};

const unclassifiedFlags = (flags: string[]): string[] =>
  flags.filter((flag) => flagKind(flag) === undefined);

it('reports an unexpected flag right after --title', async () => {
  const flags = await publishedFlags(
    { 'body.md': 'Adds it.\n', 'title.md': '--unexpected\n' },
    (directory) => dryRunPullRequest(directory),
  );

  expect(unclassifiedFlags(flags)).toEqual(['--unexpected']);
});

it('classifies every flag of a create command', async () => {
  const flags = await publishedFlags(
    { 'body.md': 'Adds it.\n', 'title.md': 'Add a feature\n' },
    (directory) => dryRunPullRequest(directory),
  );

  expect(flags.length).toBeGreaterThan(0);
  expect(unclassifiedFlags(flags)).toEqual([]);
});

it('classifies every flag of an edit command', async () => {
  const flags = await publishedFlags(
    { 'body.md': 'Adds it.\n', 'title.md': 'Add a feature\n' },
    (directory) => dryRunPullRequestEdit(directory),
  );

  expect(flags.length).toBeGreaterThan(0);
  expect(unclassifiedFlags(flags)).toEqual([]);
});

it('classifies every flag of a comment command', async () => {
  const flags = await publishedFlags({ 'comment.md': 'Looks good.\n' }, (directory) => ({
    action: 'dryRun',
    kind: 'comment',
    repository,
    directory,
    pr: 7,
    file: 'comment.md',
  }));

  expect(flags.length).toBeGreaterThan(0);
  expect(unclassifiedFlags(flags)).toEqual([]);
});

it('classifies every flag of a review command', async () => {
  const flags = await publishedFlags(
    {
      'review.json': `${JSON.stringify({
        comments: [{ path: 'src/a.ts', line: 3, body: 'Fine.' }],
      })}\n`,
    },
    (directory) => ({ action: 'dryRun', kind: 'review', repository, directory, pr: 7 }),
  );

  expect(flags.length).toBeGreaterThan(0);
  expect(unclassifiedFlags(flags)).toEqual([]);
});
