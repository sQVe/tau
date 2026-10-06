import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';

import { checkOutput, parseRepository, readJson } from '../../github.js';
import type { Runtime } from '../../github.js';
import { existingEntry } from '../../reviewCapture/reviewDirectory.js';
import { checkTauDirectory, locateTauChild } from '../../tauDirectory.js';
import { readGit } from './git.js';
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

export const runPath = 'pr';
export const runPrefix = 'run-';

const bodyFileName = 'body.md';

const pullRequestViewSchema = Type.Object({
  url: Type.String(),
  title: Type.String(),
  body: Type.String(),
  baseRefName: Type.String(),
  isDraft: Type.Boolean(),
  headRefOid: Type.String(),
});

const runName = (root: string, directory: string) => {
  const located = locateTauChild(root, runPath, runPrefix, directory);

  if (located.kind === 'outside') {
    throw new Error(`The body directory must be in .tau/${runPath}, not ${directory}.`);
  }

  if (located.kind === 'nested') {
    throw new Error(`The body directory must sit directly in .tau/${runPath}, not ${directory}.`);
  }

  if (located.kind === 'unnamed') {
    throw new Error(`The body directory must be named ${runPrefix}* by prepare, not ${directory}.`);
  }

  return located.name;
};

// A linked directory or body.md could make verify compare a file from outside the checkout.
const readBody = async (root: string, directory: string) => {
  const name = runName(root, directory);

  await checkTauDirectory(root, `${runPath}/${name}`);

  const path = join(root, '.tau', runPath, name, bodyFileName);
  const entry = await existingEntry(path);

  if (entry === undefined) {
    throw new Error(`No ${bodyFileName} at ${path}. Write the approved body there first.`);
  }

  if (entry.isSymbolicLink()) {
    throw new Error(`Refusing to read through a symlink: ${path}`);
  }

  return readFile(path, 'utf8');
};

const readPublished = async (
  runtime: Runtime,
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

const requireValue = <Value>(name: string, value: Value | undefined): Value => {
  if (value === undefined) {
    throw new Error(`verify needs ${name}.`);
  }

  return value;
};

const parsePullRequestNumber = (pr: number | undefined) => {
  const number = requireValue('pr', pr);

  if (!Number.isSafeInteger(number)) {
    throw new TypeError(`pr must be an integer, not ${number}.`);
  }

  if (number < 1) {
    throw new Error(`pr must be 1 or more, not ${number}.`);
  }

  return number;
};

// Reads the run's body.md, local HEAD, and the published pull request, and writes nothing.
export const readVerify = async (
  runtime: Runtime,
  root: string,
  request: VerifyRequest,
): Promise<VerifyResult> => {
  const repository = parseRepository(requireValue('repository', request.repository));
  const pr = parsePullRequestNumber(request.pr);
  const directory = requireValue('directory', request.directory);
  const title = requireValue('title', request.title);
  const base = requireValue('base', request.base);
  const draft = requireValue('draft', request.draft);
  const body = await readBody(root, directory);
  const head = await readGit(root, ['rev-parse', 'HEAD']);
  const expected: PullRequestFields = { title, body, base, draft, head };

  const repositoryName = `${repository.host}/${repository.owner}/${repository.name}`;
  const { url, ...published } = await readPublished(runtime, repositoryName, pr);
  const { differences } = comparePullRequest(expected, published);

  return { url, matches: differences.length === 0, differences };
};
