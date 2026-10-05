import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { errorMessage } from '../../errors.js';
import type { Exec } from '../../exec.js';
import type { IssueCommentItem, ReviewItem, ThreadNode } from './threads.js';

export interface Repository {
  host: string;
  owner: string;
  name: string;
}

export interface Runtime {
  exec: Exec;
  cwd: string;
  signal: AbortSignal | undefined;
}

// TypeScript accepts an assertion arrow function only through a declared type.
type CheckOutput = <Schema extends TSchema>(
  commandArguments: readonly string[],
  schema: Schema,
  value: unknown,
) => asserts value is Static<Schema>;

const threadsQuery = `query ($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          viewerCanReply
          viewerCanResolve
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              databaseId
              author { login typename: __typename }
              body
              url
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  }
}`;

const resolveMutation =
  'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }';

const outputPreviewLength = 200;

const graphqlAuthorSchema = Type.Union([
  Type.Object({ login: Type.String(), typename: Type.String() }),
  Type.Null(),
]);

const restUserSchema = Type.Union([
  Type.Object({ login: Type.String(), type: Type.String() }),
  Type.Null(),
]);

const viewerSchema = Type.Object({ login: Type.String() });

const pullRequestSchema = Type.Object({
  number: Type.Integer(),
  url: Type.String(),
  state: Type.String(),
  author: Type.Object({ login: Type.String() }),
  headRefOid: Type.String(),
});

const threadSchema = Type.Object({
  id: Type.String(),
  isResolved: Type.Boolean(),
  isOutdated: Type.Boolean(),
  path: Type.String(),
  line: Type.Union([Type.Integer(), Type.Null()]),
  viewerCanReply: Type.Boolean(),
  viewerCanResolve: Type.Boolean(),
  comments: Type.Object({
    pageInfo: Type.Object({ hasNextPage: Type.Boolean() }),
    nodes: Type.Array(
      Type.Object({
        databaseId: Type.Integer(),
        author: graphqlAuthorSchema,
        body: Type.String(),
        url: Type.String(),
        createdAt: Type.String(),
        updatedAt: Type.String(),
      }),
      { minItems: 1 },
    ),
  }),
});

const threadPagesSchema = Type.Array(
  Type.Object({
    data: Type.Object({
      repository: Type.Object({
        pullRequest: Type.Object({
          reviewThreads: Type.Object({ nodes: Type.Array(threadSchema) }),
        }),
      }),
    }),
  }),
);

const reviewPagesSchema = Type.Array(
  Type.Array(
    Type.Object({
      id: Type.Integer(),
      user: restUserSchema,
      state: Type.String(),
      body: Type.String(),
      html_url: Type.String(),
    }),
  ),
);

const commentPagesSchema = Type.Array(
  Type.Array(
    Type.Object({
      id: Type.Integer(),
      user: restUserSchema,
      body: Type.String(),
      html_url: Type.String(),
    }),
  ),
);

const createdCommentSchema = Type.Object({ id: Type.Integer() });

const resolvedThreadSchema = Type.Object({
  data: Type.Object({
    resolveReviewThread: Type.Object({
      thread: Type.Object({ isResolved: Type.Boolean() }),
    }),
  }),
});

export type PullRequest = Static<typeof pullRequestSchema>;

// gh exited with 0, so GitHub made the write, but the tool could not read what gh printed.
export class UnreadWriteOutputError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = 'UnreadWriteOutputError';
  }
}

const repositoryPart = /^[\w.-]+$/u;
const hostPattern = /^[\w.-]+(?::\d+)?$/u;

export const parseRepository = (repository: string): Repository => {
  const [host = '', owner = '', name = '', ...rest] = repository.split('/');
  const namesValid = repositoryPart.test(owner) && repositoryPart.test(name);

  if (rest.length > 0 || !hostPattern.test(host) || !namesValid) {
    throw new Error(
      `repository must be <host>/<owner>/<name>, such as github.com/sQVe/tau, not ${repository}.`,
    );
  }

  return { host, owner, name };
};

const isLongValue = (argument: string) =>
  argument.startsWith('query=') || argument.startsWith('body=');

const label = (commandArguments: readonly string[]) =>
  ['gh', ...commandArguments.filter((argument) => !isLongValue(argument))].join(' ');

const preview = (stdout: string) => stdout.slice(0, outputPreviewLength);

const run = async (runtime: Runtime, commandArguments: string[]) => {
  const result = await runtime.exec('gh', commandArguments, {
    cwd: runtime.cwd,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  if (result.code !== 0 || result.killed) {
    const output = (result.stderr || result.stdout).trim();

    throw new Error(`${label(commandArguments)} failed: ${output}`);
  }

  return result.stdout;
};

const describeProblem = (schema: TSchema, value: unknown) => {
  const [error] = Value.Errors(schema, value);

  return error === undefined ? 'unknown problem' : `${error.instancePath || '/'} ${error.message}`;
};

const parseJson = (commandArguments: readonly string[], stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${label(commandArguments)} printed output that is not JSON: ${preview(stdout)}`,
      { cause: error },
    );
  }
};

const readJson = async (runtime: Runtime, commandArguments: string[]): Promise<unknown> =>
  parseJson(commandArguments, await run(runtime, commandArguments));

// Names the command and the first field that does not match.
const checkOutput: CheckOutput = (commandArguments, schema, value) => {
  if (!Value.Check(schema, value)) {
    throw new Error(
      `${label(commandArguments)} printed unexpected output: ${describeProblem(schema, value)}`,
    );
  }
};

export const readViewer = async (runtime: Runtime, repository: Repository): Promise<string> => {
  const commandArguments = ['api', 'user', '--hostname', repository.host];
  const viewer = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, viewerSchema, viewer);

  return viewer.login;
};

export const readPullRequest = async (
  runtime: Runtime,
  repository: Repository,
  pr: number,
): Promise<PullRequest> => {
  const commandArguments = [
    'pr',
    'view',
    String(pr),
    '--repo',
    `${repository.host}/${repository.owner}/${repository.name}`,
    '--json',
    'number,url,state,author,headRefOid',
  ];

  const pullRequest = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, pullRequestSchema, pullRequest);

  return pullRequest;
};

export const readThreads = async (
  runtime: Runtime,
  repository: Repository,
  pr: number,
): Promise<ThreadNode[]> => {
  const commandArguments = [
    'api',
    'graphql',
    '--hostname',
    repository.host,
    '--paginate',
    '--slurp',
    '-f',
    `owner=${repository.owner}`,
    '-f',
    `name=${repository.name}`,
    '-F',
    `number=${pr}`,
    '-f',
    `query=${threadsQuery}`,
  ];

  const pages = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, threadPagesSchema, pages);

  return pages.flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes);
};

const restListArguments = (repository: Repository, path: string) => [
  'api',
  '--hostname',
  repository.host,
  '--paginate',
  '--slurp',
  `repos/${repository.owner}/${repository.name}/${path}`,
];

export const readReviews = async (
  runtime: Runtime,
  repository: Repository,
  pr: number,
): Promise<ReviewItem[]> => {
  const commandArguments = restListArguments(repository, `pulls/${pr}/reviews`);
  const pages = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, reviewPagesSchema, pages);

  return pages.flat();
};

export const readIssueComments = async (
  runtime: Runtime,
  repository: Repository,
  pr: number,
): Promise<IssueCommentItem[]> => {
  const commandArguments = restListArguments(repository, `issues/${pr}/comments`);
  const pages = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, commentPagesSchema, pages);

  return pages.flat();
};

const writeJson = async (runtime: Runtime, commandArguments: string[]): Promise<unknown> => {
  const stdout = await run(runtime, commandArguments);

  try {
    return parseJson(commandArguments, stdout);
  } catch (error) {
    throw new UnreadWriteOutputError(errorMessage(error), { cause: error });
  }
};

const checkWriteOutput: CheckOutput = (commandArguments, schema, value) => {
  try {
    checkOutput(commandArguments, schema, value);
  } catch (error) {
    throw new UnreadWriteOutputError(errorMessage(error), { cause: error });
  }
};

const postArguments = (repository: Repository, path: string, body: string) => [
  'api',
  '--hostname',
  repository.host,
  '-X',
  'POST',
  `repos/${repository.owner}/${repository.name}/${path}`,
  '-f',
  `body=${body}`,
];

// Returns the ID of the new comment.
export const postReply = async (
  runtime: Runtime,
  repository: Repository,
  reply: { pr: number; replyTo: number; body: string },
): Promise<number> => {
  const path = `pulls/${reply.pr}/comments/${reply.replyTo}/replies`;
  const commandArguments = postArguments(repository, path, reply.body);
  const created = await writeJson(runtime, commandArguments);

  checkWriteOutput(commandArguments, createdCommentSchema, created);

  return created.id;
};

// Returns the ID of the new comment.
export const postIssueComment = async (
  runtime: Runtime,
  repository: Repository,
  comment: { pr: number; body: string },
): Promise<number> => {
  const path = `issues/${comment.pr}/comments`;
  const commandArguments = postArguments(repository, path, comment.body);
  const created = await writeJson(runtime, commandArguments);

  checkWriteOutput(commandArguments, createdCommentSchema, created);

  return created.id;
};

export const resolveThread = async (
  runtime: Runtime,
  repository: Repository,
  threadId: string,
): Promise<void> => {
  const commandArguments = [
    'api',
    'graphql',
    '--hostname',
    repository.host,
    '-f',
    `query=${resolveMutation}`,
    '-F',
    `id=${threadId}`,
  ];

  const result = await writeJson(runtime, commandArguments);

  checkWriteOutput(commandArguments, resolvedThreadSchema, result);

  if (!result.data.resolveReviewThread.thread.isResolved) {
    throw new Error(`${label(commandArguments)} left the thread unresolved.`);
  }
};
