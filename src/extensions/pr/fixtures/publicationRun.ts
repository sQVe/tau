import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { onTestFinished } from 'vitest';

import type { GhFake } from '../../../../tests/prGhFake.js';
import { createPublicationTool } from './publicationRepository.js';
import type { PublicationRun } from './publicationRepository.js';

export type { PublicationRun } from './publicationRepository.js';

export const publicationRepository = 'github.com/sQVe/tau';

export const setUpPublicationTests = (): ReturnType<typeof createPublicationTool> =>
  createPublicationTool(onTestFinished);

export const preparePublicationRun = async (run: PublicationRun): Promise<string> => {
  const { directory } = await run({ action: 'prepare' });

  return String(directory);
};

export const writeRunFile = async (
  directory: string,
  file: string,
  contents: string,
): Promise<string> => {
  const path = join(directory, file);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);

  return path;
};

export const foreignInputOf = (
  name: 'base' | 'head' | 'draft' | 'file',
): Record<string, boolean | string> => {
  if (name === 'draft') {
    return { draft: true };
  }

  return name === 'file' ? { file: 'comment.md' } : { [name]: 'main' };
};

export const dryRunPullRequest = (directory: string) =>
  ({
    action: 'dryRun',
    kind: 'pullRequest',
    repository: publicationRepository,
    directory,
    base: 'main',
    head: 'feature',
    draft: true,
  }) as const;

export const dryRunPullRequestEdit = (directory: string) =>
  ({
    action: 'dryRun',
    kind: 'pullRequest',
    repository: publicationRepository,
    directory,
    pr: 7,
  }) as const;

export const publishedCommands = (fake: GhFake): string[] =>
  fake.calls.map((call) => call.commandArguments.slice(0, 2).join(' '));

export const publishedFilePath = (fake: GhFake, index = 0): string => {
  const commandArguments =
    fake.writes[index]?.commandArguments ?? fake.calls[index]?.commandArguments ?? [];

  const flag = commandArguments.includes('--input') ? '--input' : '--body-file';

  return commandArguments[commandArguments.indexOf(flag) + 1] ?? '';
};

export const preparePullRequestRun = async (
  run: PublicationRun,
  contents: { title?: string; body?: string } = {},
): Promise<string> => {
  const directory = await preparePublicationRun(run);

  await writeRunFile(directory, 'title.md', contents.title ?? 'Add a feature\n');
  await writeRunFile(directory, 'body.md', contents.body ?? 'Adds it.\n');

  return directory;
};
