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
import { flagKind } from './publishExecution.js';

const setUp = () => setUpPublication(onTestFinished);

// Skips the value after a value or file flag, as verifiedCopyArguments does.
const commandFlags = (commandArguments: readonly string[]): string[] => {
  const flags: string[] = [];

  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index] ?? '';

    if (!argument.startsWith('--')) {
      continue;
    }

    flags.push(argument);

    const kind = flagKind(argument);

    if (kind === 'value' || kind === 'file') {
      index += 1;
    }
  }

  return flags;
};

const flagKinds = (flags: string[]): string[] =>
  flags.map((flag) => `${flag}:${flagKind(flag) ?? 'unclassified'}`);

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

  return commandFlags(fake.writes[0]?.commandArguments ?? []);
};

it('classifies every flag of a create command', async () => {
  const flags = await publishedFlags(
    { 'body.md': 'Adds it.\n', 'title.md': 'Add a feature\n' },
    (directory) => dryRunPullRequest(directory),
  );

  expect(flagKinds(flags)).toEqual([
    '--repo:value',
    '--base:value',
    '--head:value',
    '--title:value',
    '--body-file:file',
    '--draft:boolean',
  ]);
});

it('classifies every flag of an edit command', async () => {
  const flags = await publishedFlags(
    { 'body.md': 'Adds it.\n', 'title.md': 'Add a feature\n' },
    (directory) => dryRunPullRequestEdit(directory),
  );

  expect(flagKinds(flags)).toEqual(['--repo:value', '--title:value', '--body-file:file']);
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

  expect(flagKinds(flags)).toEqual(['--repo:value', '--body-file:file']);
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

  expect(flagKinds(flags)).toEqual(['--hostname:value', '--method:value', '--input:file']);
});
