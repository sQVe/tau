import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { outputPreviewLength } from '../../../command.js';
import { parseRepository, requirePullRequestNumber } from '../../../github/github.js';
import type { Repository } from '../../../github/github.js';
import { formatRepository } from '../../../github/repositoryTargetDecisions.js';
import { checkProse } from '../../../prose.js';
import type { ProseRule } from '../../../prose.js';
import { describeSchemaProblem } from '../../../schema.js';
import { climbsOut, existingEntry, rejectLinkedFile } from '../../../tauDirectory.js';
import {
  bodyFileName,
  requireValue,
  reviewFileName,
  runDirectoryPath,
  runName,
  titleFileName,
} from '../prRun.js';
import type { PublicationFile, PublicationTargetFacts } from './publishDecisions.js';
import type { PublicationKind } from './publishKind.js';

export interface PublishRequest {
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

export interface PublicationFinding {
  file: string;
  field?: string;
  rule: ProseRule;
  line: number;
  excerpt: string;
}

export interface PublicationPlan {
  target: PublicationTargetFacts;
  files: RunFile[];
  commandArguments: string[];
  findings: PublicationFinding[];
}

export interface PublicationTarget {
  action: 'dryRun' | 'publish';
  kind: PublicationKind;
  repository: Repository;
  directory: string;
  request: PublishRequest;
}

interface PullRequestFiles {
  title: string;
  bodyFile: RunFile;
  files: RunFile[];
  findings: PublicationFinding[];
  repositoryTarget: string;
}

const reviewCommentSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    body: Type.String(),
    position: Type.Optional(Type.Integer({ minimum: 1 })),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    side: Type.Optional(Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')])),
    start_line: Type.Optional(Type.Integer({ minimum: 1 })),
    start_side: Type.Optional(Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')])),
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

const requireText = (action: string, name: string, value: string | undefined): string => {
  const text = requireValue(action, name, value).trim();

  if (text === '') {
    throw new Error(`${action} needs ${name}.`);
  }

  return text;
};

const requireKind = (action: string, kind: PublicationKind | undefined): PublicationKind => {
  if (kind === undefined) {
    throw new Error(`${action} needs kind: pullRequest, comment, or review.`);
  }

  return kind;
};

const foreignInputs: Readonly<Record<PublicationKind, readonly (keyof PublishRequest)[]>> = {
  pullRequest: ['file'],
  comment: ['base', 'head', 'draft'],
  review: ['file', 'base', 'head', 'draft'],
};

const rejectForeignInputs = (action: string, kind: PublicationKind, request: PublishRequest) => {
  for (const name of foreignInputs[kind]) {
    if (request[name] !== undefined) {
      throw new Error(`${action} with kind ${kind} cannot take ${name}.`);
    }
  }
};

const runDirectory = async (root: string, action: string, directory: string | undefined) => {
  const requested = requireValue(action, 'directory', directory);
  const name = await runName(root, requested, 'The run directory');

  return runDirectoryPath(root, name);
};

export const publicationTarget = async (
  action: PublicationTarget['action'],
  root: string,
  request: PublishRequest,
): Promise<PublicationTarget> => {
  const kind = requireKind(action, request.kind);
  const repository = parseRepository(requireValue(action, 'repository', request.repository));

  rejectForeignInputs(action, kind, request);
  const directory = await runDirectory(root, action, request.directory);

  return { action, kind, repository, directory, request };
};

// A linked directory on the way to the file could make the read leave the run directory.

const rejectPathLinks = async (directory: string, file: string) => {
  let path = directory;

  for (const segment of file.split(/[/\\]/u)) {
    path = join(path, segment);
    // oxlint-disable-next-line no-await-in-loop -- Checking in path order names the first refusal.
    await rejectLinkedFile(path, 'read');
  }
};

const readPublicationFile = async (directory: string, file: string): Promise<RunFile> => {
  const path = join(directory, file);

  await rejectPathLinks(directory, file);

  const entry = await existingEntry(path);

  if (entry === undefined) {
    throw new Error(`No ${file} at ${path}. Write it there first.`);
  }

  // A pipe opens without a writer only in non-blocking mode. The type check and the read use one
  // handle, and O_NOFOLLOW refuses a symlink swapped in after the checks.
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const handle = await open(path, flags);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error(`Refusing to read a path that is not a regular file: ${path}`);
    }

    const bytes = await handle.readFile();

    return { file, path, bytes, text: bytes.toString('utf8') };
  } finally {
    await handle.close();
  }
};

const requireCommentFile = (action: string, file: string | undefined): string => {
  const requested = requireValue(action, 'file', file);

  if (isAbsolute(requested)) {
    throw new Error(`The comment file must be relative to the run directory, not ${requested}.`);
  }

  if (climbsOut(requested)) {
    throw new Error(`The comment file must stay in the run directory, not ${requested}.`);
  }

  if (requested.includes('\\')) {
    throw new Error(
      `The comment file must not contain a backslash, which is a name character on some platforms: ${requested}`,
    );
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

const fileFindings = (file: RunFile): PublicationFinding[] =>
  checkProse(file.text).map((finding) => ({
    file: file.file,
    rule: finding.rule,
    line: finding.line,
    excerpt: finding.excerpt,
  }));

const reviewFindings = (
  file: RunFile,
  review: Static<typeof reviewSchema>,
): PublicationFinding[] => {
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

const readPullRequestFiles = async (target: PublicationTarget): Promise<PullRequestFiles> => {
  const { directory, repository } = target;
  const titleFile = await readPublicationFile(directory, titleFileName);
  const bodyFile = await readPublicationFile(directory, bodyFileName);
  const title = titleFile.text.trim();

  if (title === '') {
    throw new Error(`${titleFileName} must not be empty.`);
  }

  if (/[\r\n]/u.test(title)) {
    throw new Error(`${titleFileName} must contain one line.`);
  }

  const files = [titleFile, bodyFile];

  return {
    title,
    bodyFile,
    files,
    findings: files.flatMap(fileFindings),
    repositoryTarget: formatRepository(repository),
  };
};

const rejectCreateInput = (action: string, name: string, value: unknown) => {
  if (value === undefined) {
    return;
  }

  throw new Error(`${action} cannot take ${name} with pr. Omit ${name} or pr.`);
};

const readPullRequestEdit = async (target: PublicationTarget): Promise<PublicationPlan> => {
  const { action, directory, request } = target;

  const { title, bodyFile, files, findings, repositoryTarget } = await readPullRequestFiles(target);

  const pr = requirePullRequestNumber(action, request.pr);

  rejectCreateInput(action, 'base', request.base);
  rejectCreateInput(action, 'head', request.head);
  rejectCreateInput(action, 'draft', request.draft);

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

  const facts: PublicationTargetFacts = {
    kind: 'pullRequest',
    repository: repositoryTarget,
    directory,
    pr,
  };

  return { target: facts, files, commandArguments, findings };
};

const readPullRequestCreate = async (target: PublicationTarget): Promise<PublicationPlan> => {
  const { action, directory, request } = target;

  const { title, bodyFile, files, findings, repositoryTarget } = await readPullRequestFiles(target);

  const base = requireText(action, 'base', request.base);
  const head = requireText(action, 'head', request.head);
  const isDraft = request.draft === true;
  const draft = isDraft ? ['--draft'] : [];

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

  const facts: PublicationTargetFacts = {
    kind: 'pullRequest',
    repository: repositoryTarget,
    directory,
    base,
    head,
    draft: isDraft,
  };

  return { target: facts, files, commandArguments, findings };
};

const readPullRequest = (target: PublicationTarget): Promise<PublicationPlan> =>
  target.request.pr === undefined ? readPullRequestCreate(target) : readPullRequestEdit(target);

const readComment = async (target: PublicationTarget): Promise<PublicationPlan> => {
  const { action, directory, repository, request } = target;
  const pr = requirePullRequestNumber(action, request.pr);
  const file = await readPublicationFile(directory, requireCommentFile(action, request.file));

  if (file.text.trim() === '') {
    throw new Error(`${file.file} must not be empty.`);
  }

  const repositoryTarget = formatRepository(repository);

  const commandArguments = [
    'pr',
    'comment',
    String(pr),
    '--repo',
    repositoryTarget,
    '--body-file',
    file.path,
  ];

  const facts: PublicationTargetFacts = {
    kind: 'comment',
    repository: repositoryTarget,
    directory,
    pr,
  };

  return { target: facts, files: [file], commandArguments, findings: fileFindings(file) };
};

const needsBody = (event: string | undefined): event is 'COMMENT' | 'REQUEST_CHANGES' =>
  event === 'COMMENT' || event === 'REQUEST_CHANGES';

const rejectReviewComments = (review: Static<typeof reviewSchema>) => {
  for (const [index, comment] of (review.comments ?? []).entries()) {
    if (comment.body.trim() === '') {
      throw new Error(`${reviewFileName} comments[${index}] needs a body.`);
    }

    if (comment.line !== undefined && comment.position !== undefined) {
      throw new Error(`${reviewFileName} comments[${index}] cannot take both line and position.`);
    }

    if (comment.start_line !== undefined && comment.line === undefined) {
      throw new Error(`${reviewFileName} comments[${index}] needs line when start_line is set.`);
    }

    if (comment.start_side !== undefined && comment.start_line === undefined) {
      throw new Error(
        `${reviewFileName} comments[${index}] needs start_line when start_side is set.`,
      );
    }
  }

  const missingPosition = (review.comments ?? []).findIndex(
    (comment) => comment.line === undefined && comment.position === undefined,
  );

  if (missingPosition !== -1) {
    throw new Error(`${reviewFileName} comments[${missingPosition}] needs line or position.`);
  }
};

const readReview = async (target: PublicationTarget): Promise<PublicationPlan> => {
  const { action, directory, repository, request } = target;
  const pr = requirePullRequestNumber(action, request.pr);
  const file = await readPublicationFile(directory, reviewFileName);
  const repositoryTarget = formatRepository(repository);
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

  rejectReviewComments(review);

  if (needsBody(review.event) && (review.body ?? '').trim() === '') {
    throw new Error(`${reviewFileName} needs a body for a ${review.event} event.`);
  }

  const facts: PublicationTargetFacts = {
    kind: 'review',
    repository: repositoryTarget,
    directory,
    pr,
  };

  return { target: facts, files: [file], commandArguments, findings: reviewFindings(file, review) };
};

export const planPublication = (target: PublicationTarget): Promise<PublicationPlan> => {
  if (target.kind === 'pullRequest') {
    return readPullRequest(target);
  }

  if (target.kind === 'comment') {
    return readComment(target);
  }

  return readReview(target);
};
