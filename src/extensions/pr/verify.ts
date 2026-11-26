import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';

import type { CommandRuntime } from '../../command.js';
import { readGit } from '../../git.js';
import {
  checkOutput,
  parseRepository,
  readJson,
  requirePullRequestNumber,
} from '../../github/github.js';
import { formatRepository } from '../../github/repositoryTargetDecisions.js';
import { existingEntry, rejectLinkedFile } from '../../tauDirectory.js';
import { bodyFileName, requireValue, runDirectoryPath, runName } from './prRun.js';
import { comparePullRequest } from './verifyDecisions.js';
import type { Difference, PullRequestFields } from './verifyDecisions.js';

export interface VerifyRequest {
  repository?: string;
  pr?: number;
  directory?: string;
  title?: string;
  base?: string;
  draft?: boolean;
}

export interface VerifyResult {
  url: string;
  matches: boolean;
  differences: Difference[];
}

const pullRequestViewSchema = Type.Object({
  url: Type.String(),
  title: Type.String(),
  body: Type.String(),
  baseRefName: Type.String(),
  isDraft: Type.Boolean(),
  headRefOid: Type.String(),
});

// A linked directory or body.md, symbolic or hard, could make verify compare a file from outside
// the checkout.
const readBody = async (root: string, directory: string) => {
  const name = await runName(root, directory, 'The body directory');
  const path = join(runDirectoryPath(root, name), bodyFileName);

  const entry = await existingEntry(path);

  if (entry === undefined) {
    throw new Error(`No ${bodyFileName} at ${path}. Write the approved body there first.`);
  }

  await rejectLinkedFile(path, 'read');

  return readFile(path, 'utf8');
};

const readPublished = async (
  runtime: CommandRuntime,
  repository: string,
  pr: number,
): Promise<PullRequestFields & { url: string }> => {
  const commandArguments = [
    'pr',
    'view',
    String(pr),
    '--repo',
    repository,
    '--json',
    'url,title,body,baseRefName,isDraft,headRefOid',
  ];

  const view = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, pullRequestViewSchema, view);

  return {
    url: view.url,
    title: view.title,
    body: view.body,
    base: view.baseRefName,
    draft: view.isDraft,
    head: view.headRefOid,
  };
};

// Reads the run's body.md, local HEAD, and the published pull request, and writes nothing.
export const readVerify = async (
  runtime: CommandRuntime,
  root: string,
  request: VerifyRequest,
): Promise<VerifyResult> => {
  const repository = parseRepository(requireValue('verify', 'repository', request.repository));
  const pr = requirePullRequestNumber('verify', request.pr);
  const directory = requireValue('verify', 'directory', request.directory);
  const title = requireValue('verify', 'title', request.title);
  const base = requireValue('verify', 'base', request.base);
  const draft = requireValue('verify', 'draft', request.draft);
  const body = await readBody(root, directory);
  const head = await readGit(root, ['rev-parse', 'HEAD']);
  const expected: PullRequestFields = { title, body, base, draft, head };

  const { url, ...published } = await readPublished(runtime, formatRepository(repository), pr);
  const { differences } = comparePullRequest(expected, published);

  return { url, matches: differences.length === 0, differences };
};
