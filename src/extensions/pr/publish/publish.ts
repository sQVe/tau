import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import type { CommandRuntime } from '../../../command.js';
import { outputPreviewLength } from '../../../command.js';
import { parseRepository, run } from '../../../github/github.js';
import type { Repository } from '../../../github/github.js';
import { formatRepository } from '../../../github/repositoryTargetDecisions.js';
import { checkProse } from '../../../prose.js';
import type { ProseRule } from '../../../prose.js';
import { describeSchemaProblem, isRecord } from '../../../schema.js';
import {
  checkTauDirectory,
  climbsOut,
  existingEntry,
  rejectLinkedFile,
  requireTauChild,
} from '../../../tauDirectory.js';
import { requirePullRequestNumber } from '../pullRequestNumber.js';
import { runPath, runPrefix } from '../verify.js';
import { decidePublication, publicationToken } from './publishDecisions.js';
import type { PublicationFile } from './publishDecisions.js';

type PublicationKind = 'pullRequest' | 'comment' | 'review';

export interface PublicationRequest {
  kind?: PublicationKind;
  repository?: string;
  directory?: string;
  pr?: number;
  base?: string;
  head?: string;
  draft?: boolean;
  file?: string;
  token?: string;
}

interface RunFile extends PublicationFile {
  path: string;
  text: string;
}

interface FileFinding {
  file: string;
  rule: ProseRule;
  line: number;
  excerpt: string;
}

interface ReviewFinding extends FileFinding {
  field: string;
}

type PublicationFinding = FileFinding | ReviewFinding;

interface PublicationPlan {
  files: RunFile[];
  commandArguments: string[];
  findings: PublicationFinding[];
}

interface PublicationTarget {
  action: 'dryRun' | 'publish';
  kind: PublicationKind;
  repository: Repository;
  directory: string;
  request: PublicationRequest;
}

const titleFileName = 'title.md';
const bodyFileName = 'body.md';
const reviewFileName = 'review.json';

const reviewCommentSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    body: Type.String(),
    position: Type.Optional(Type.Integer({ minimum: 1 })),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    side: Type.Optional(Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')])),
    start_line: Type.Optional(Type.Integer({ minimum: 1 })),
    start_side: Type.Optional(Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')])),
    in_reply_to: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const reviewSchema = Type.Object(
  {
    commit_id: Type.Optional(Type.String({ minLength: 1 })),
    body: Type.Optional(Type.String()),
    event: Type.Optional(
      Type.Union([
        Type.Literal('APPROVE'),
        Type.Literal('REQUEST_CHANGES'),
        Type.Literal('COMMENT'),
      ]),
    ),
    comments: Type.Optional(Type.Array(reviewCommentSchema)),
  },
  { additionalProperties: false },
);

const repositoryPath = (repository: Repository) => `${repository.owner}/${repository.name}`;

const requireValue = <Value>(action: string, name: string, value: Value | undefined): Value => {
  if (value === undefined) {
    throw new Error(`${action} needs ${name}.`);
  }

  return value;
};

const requireKind = (action: string, kind: PublicationKind | undefined): PublicationKind => {
  if (kind === undefined) {
    throw new Error(`${action} needs kind: pullRequest, comment, or review.`);
  }

  return kind;
};

const runDirectory = async (root: string, action: string, directory: string | undefined) => {
  const requested = requireValue(action, 'directory', directory);
  const name = requireTauChild(root, runPath, runPrefix, requested, 'The run directory');

  await checkTauDirectory(root, `${runPath}/${name}`);

  return join(root, '.tau', runPath, name);
};

const publicationTarget = async (
  action: PublicationTarget['action'],
  root: string,
  request: PublicationRequest,
): Promise<PublicationTarget> => {
  const kind = requireKind(action, request.kind);
  const repository = parseRepository(requireValue(action, 'repository', request.repository));
  const directory = await runDirectory(root, action, request.directory);

  return { action, kind, repository, directory, request };
};

// A linked directory on the way to the file could make the read leave the run directory.
const rejectPathLinks = async (directory: string, file: string) => {
  let path = directory;

  for (const segment of file.split('/')) {
    path = join(path, segment);
    // oxlint-disable-next-line no-await-in-loop -- Checking in path order names the first refusal.
    await rejectLinkedFile(path, 'read');
  }
};

const readPublicationFile = async (directory: string, file: string): Promise<RunFile> => {
  const path = join(directory, file);

  await rejectPathLinks(directory, file);

  if ((await existingEntry(path)) === undefined) {
    throw new Error(`No ${file} at ${path}. Write it there first.`);
  }

  const bytes = await readFile(path);

  return { file, path, bytes, text: bytes.toString('utf8') };
};

const requireCommentFile = (action: string, file: string | undefined): string => {
  const requested = requireValue(action, 'file', file);

  if (isAbsolute(requested)) {
    throw new Error(`The comment file must be relative to the run directory, not ${requested}.`);
  }

  if (climbsOut(requested)) {
    throw new Error(`The comment file must stay in the run directory, not ${requested}.`);
  }

  if (requested === '' || normalize(requested) === '.') {
    throw new Error('The comment file must name a file in the run directory.');
  }

  return requested;
};

const parseReview = (file: RunFile): Static<typeof reviewSchema> => {
  let value: unknown;

  try {
    value = JSON.parse(file.text);
  } catch (error) {
    throw new Error(`${reviewFileName} is not JSON: ${file.text.slice(0, outputPreviewLength)}`, {
      cause: error,
    });
  }

  if (!Value.Check(reviewSchema, value)) {
    throw new Error(
      `${reviewFileName} has a bad field: ${describeSchemaProblem(reviewSchema, value)}.`,
    );
  }

  return value;
};

const fileFindings = (file: RunFile): FileFinding[] =>
  checkProse(file.text).map((finding) => ({
    file: file.file,
    rule: finding.rule,
    line: finding.line,
    excerpt: finding.excerpt,
  }));

const reviewFindings = (file: RunFile, review: Static<typeof reviewSchema>): ReviewFinding[] => {
  const sources: { field: string; text: string }[] = [];

  if (review.body !== undefined) {
    sources.push({ field: 'body', text: review.body });
  }

  for (const [index, comment] of (review.comments ?? []).entries()) {
    sources.push({ field: `comments[${index}].body`, text: comment.body });
  }

  return sources.flatMap(({ field, text }) =>
    checkProse(text).map((finding) => ({
      file: file.file,
      field,
      rule: finding.rule,
      line: finding.line,
      excerpt: finding.excerpt,
    })),
  );
};

const readPullRequest = async (target: PublicationTarget): Promise<PublicationPlan> => {
  const { action, directory, repository, request } = target;
  const titleFile = await readPublicationFile(directory, titleFileName);
  const bodyFile = await readPublicationFile(directory, bodyFileName);
  const title = titleFile.text.trim();
  const files = [titleFile, bodyFile];
  const findings = files.flatMap(fileFindings);
  const repositoryTarget = formatRepository(repository);

  if (request.pr !== undefined) {
    const pr = requirePullRequestNumber(action, request.pr);

    const commandArguments = [
      'pr',
      'edit',
      String(pr),
      '--repo',
      repositoryTarget,
      '--title',
      title,
      '--body-file',
      bodyFile.path,
    ];

    return { files, commandArguments, findings };
  }

  const base = requireValue(action, 'base', request.base);
  const head = requireValue(action, 'head', request.head);
  const draft = request.draft === true ? ['--draft'] : [];

  const commandArguments = [
    'pr',
    'create',
    '--repo',
    repositoryTarget,
    '--base',
    base,
    '--head',
    head,
    '--title',
    title,
    '--body-file',
    bodyFile.path,
    ...draft,
  ];

  return { files, commandArguments, findings };
};

const readComment = async (target: PublicationTarget): Promise<PublicationPlan> => {
  const { action, directory, repository, request } = target;
  const pr = requirePullRequestNumber(action, request.pr);
  const file = await readPublicationFile(directory, requireCommentFile(action, request.file));

  const commandArguments = [
    'pr',
    'comment',
    String(pr),
    '--repo',
    formatRepository(repository),
    '--body-file',
    file.path,
  ];

  return { files: [file], commandArguments, findings: fileFindings(file) };
};

const readReview = async (target: PublicationTarget): Promise<PublicationPlan> => {
  const { action, directory, repository, request } = target;
  const pr = requirePullRequestNumber(action, request.pr);
  const file = await readPublicationFile(directory, reviewFileName);
  const path = `repos/${repositoryPath(repository)}/pulls/${pr}/reviews`;

  const commandArguments = [
    'api',
    '--hostname',
    repository.host,
    '--method',
    'POST',
    path,
    '--input',
    file.path,
  ];

  const review = parseReview(file);

  return { files: [file], commandArguments, findings: reviewFindings(file, review) };
};

const planPublication = (target: PublicationTarget): Promise<PublicationPlan> => {
  if (target.kind === 'pullRequest') {
    return readPullRequest(target);
  }

  if (target.kind === 'comment') {
    return readComment(target);
  }

  return readReview(target);
};

const firstUrlLine = (stdout: string): string | null =>
  stdout.split(/\r?\n/u).find((line) => line.startsWith('https://')) ?? null;

const reviewUrl = (stdout: string): string | null => {
  try {
    const value: unknown = JSON.parse(stdout);

    return isRecord(value) && typeof value.html_url === 'string' ? value.html_url : null;
  } catch {
    return null;
  }
};

const publishedUrl = (kind: PublicationKind, stdout: string): string | null =>
  kind === 'review' ? reviewUrl(stdout) : firstUrlLine(stdout);

// Reads the files a publish would send, reports the prose findings, and pins their bytes.
export const readPublication = async (
  root: string,
  request: PublicationRequest,
): Promise<Record<string, unknown>> => {
  const target = await publicationTarget('dryRun', root, request);
  const plan = await planPublication(target);

  return {
    kind: target.kind,
    token: publicationToken(plan.files),
    findings: plan.findings,
  };
};

// Refuses unless every file still matches the token, then runs one gh command.
export const publishPublication = async (
  runtime: CommandRuntime,
  root: string,
  request: PublicationRequest,
): Promise<Record<string, unknown>> => {
  const target = await publicationTarget('publish', root, request);
  const plan = await planPublication(target);
  const token = requireValue('publish', 'token from dryRun', request.token);
  const decision = decidePublication({ token, files: plan.files });

  if (decision.kind === 'refuse') {
    throw new Error(decision.reason);
  }

  const stdout = await run(runtime, plan.commandArguments);
  const url = publishedUrl(target.kind, stdout);

  return { kind: target.kind, files: plan.files.map((file) => file.file), url };
};
