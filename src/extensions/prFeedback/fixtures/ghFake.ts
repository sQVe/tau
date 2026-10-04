import type { Exec } from '../../../exec.js';

interface FakeAuthor {
  login: string;
  bot: boolean;
}

interface FakeComment {
  id: number;
  author: FakeAuthor | null;
  body: string;
}

export interface FakeThread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  hasMoreComments: boolean;
  comments: FakeComment[];
}

interface FakeReview extends FakeComment {
  state: string;
}

interface FakePullRequest {
  number: number;
  state: string;
  author: string;
  headRefOid: string;
}

interface FakeCall {
  command: string;
  commandArguments: string[];
}

type ReadKey = 'user' | 'pr view' | 'graphql' | 'reviews' | 'comments';

type WriteKey = 'reply' | 'resolve' | 'issue comment';

type CommandKey = ReadKey | WriteKey;

type FakeWrite =
  | { kind: 'reply'; replyTo: number; body: string }
  | { kind: 'resolve'; threadId: string }
  | { kind: 'comment'; body: string };

export interface GhFake {
  exec: Exec;
  calls: FakeCall[];
  viewer: string;
  pullRequest: FakePullRequest | undefined;
  threads: FakeThread[];
  reviews: FakeReview[];
  comments: FakeComment[];
  writes: FakeWrite[];
  overrideOutput: (key: CommandKey, stdout: string) => void;
  failCommand: (key: CommandKey) => void;
  failWrite: (number: number) => void;
}

const repository = 'github.com/sQVe/tau';

const commentUrl = (id: number) => `https://${repository}/pull/7#discussion_r${id}`;

const restUser = (author: FakeAuthor | null) =>
  author === null ? null : { login: author.login, type: author.bot ? 'Bot' : 'User' };

const graphqlAuthor = (author: FakeAuthor | null) =>
  author === null ? null : { login: author.login, typename: author.bot ? 'Bot' : 'User' };

// `gh --paginate --slurp` prints an array of pages. One item per page exercises the merging.
const pages = <T>(items: T[]): T[][] => (items.length === 0 ? [[]] : items.map((item) => [item]));

const argumentValue = (commandArguments: readonly string[], prefix: string) =>
  commandArguments.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? '';

const writeKey = (commandArguments: readonly string[]): WriteKey | undefined => {
  if (argumentValue(commandArguments, 'query=').startsWith('mutation')) {
    return 'resolve';
  }

  if (!commandArguments.includes('POST')) {
    return undefined;
  }

  const path = argumentValue(commandArguments, 'repos/');

  return path.endsWith('/replies') ? 'reply' : 'issue comment';
};

const readKey = (commandArguments: readonly string[]): ReadKey | undefined => {
  if (commandArguments[0] === 'pr' && commandArguments[1] === 'view') {
    return 'pr view';
  }

  if (commandArguments.includes('graphql')) {
    return 'graphql';
  }

  if (commandArguments.includes('user')) {
    return 'user';
  }

  const path = commandArguments.find((argument) => argument.startsWith('repos/'));

  if (path?.endsWith('/reviews') === true) {
    return 'reviews';
  }

  return path?.endsWith('/comments') === true ? 'comments' : undefined;
};

const commandKey = (commandArguments: readonly string[]): CommandKey | undefined =>
  writeKey(commandArguments) ?? readKey(commandArguments);

const isWriteKey = (key: CommandKey): key is WriteKey =>
  key === 'reply' || key === 'resolve' || key === 'issue comment';

export const createGhFake = (): GhFake => {
  const calls: FakeCall[] = [];
  const overrides = new Map<CommandKey, string>();
  const failures = new Set<CommandKey>();
  const failingWrites = new Set<number>();
  let writeAttempts = 0;
  let nextCommentId = 1000;

  const fake: GhFake = {
    exec: async () => ({ code: 1, killed: false, stdout: '', stderr: 'not set up' }),
    calls,
    viewer: 'sqve',
    pullRequest: { number: 7, state: 'OPEN', author: 'sqve', headRefOid: 'abc123' },
    threads: [],
    reviews: [],
    comments: [],
    writes: [],
    overrideOutput: (key, stdout) => {
      overrides.set(key, stdout);
    },
    failCommand: (key) => {
      failures.add(key);
    },
    failWrite: (number) => {
      failingWrites.add(number);
    },
  };

  const viewerAuthor = () => ({ login: fake.viewer, bot: false });

  const findThread = (predicate: (thread: FakeThread) => boolean) => {
    const found = fake.threads.find((thread) => predicate(thread));

    if (found === undefined) {
      throw new Error('Could not resolve to a node');
    }

    return found;
  };

  const postReply = (commandArguments: readonly string[]) => {
    const path = argumentValue(commandArguments, 'repos/');
    const replyTo = Number(/comments\/(\d+)\/replies$/u.exec(path)?.[1]);
    const body = argumentValue(commandArguments, 'body=');
    const thread = findThread((candidate) => candidate.comments[0]?.id === replyTo);
    const id = nextCommentId++;

    thread.comments.push({ id, author: viewerAuthor(), body });
    fake.writes.push({ kind: 'reply', replyTo, body });

    return { id, html_url: commentUrl(id) };
  };

  const resolveThread = (commandArguments: readonly string[]) => {
    const threadId = argumentValue(commandArguments, 'id=');
    const thread = findThread((candidate) => candidate.id === threadId);

    thread.isResolved = true;
    fake.writes.push({ kind: 'resolve', threadId });

    return { data: { resolveReviewThread: { thread: { isResolved: true } } } };
  };

  const postComment = (commandArguments: readonly string[]) => {
    const body = argumentValue(commandArguments, 'body=');
    const id = nextCommentId++;

    fake.comments.push({ id, author: viewerAuthor(), body });
    fake.writes.push({ kind: 'comment', body });

    return { id, html_url: `https://${repository}/pull/7#issuecomment-${id}` };
  };

  const threadNode = (thread: FakeThread) => ({
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path,
    line: thread.line,
    viewerCanReply: thread.viewerCanReply,
    viewerCanResolve: thread.viewerCanResolve,
    comments: {
      pageInfo: { hasNextPage: thread.hasMoreComments },
      nodes: thread.comments.map((comment) => ({
        databaseId: comment.id,
        author: graphqlAuthor(comment.author),
        body: comment.body,
        url: commentUrl(comment.id),
        createdAt: '2026-10-01T10:00:00Z',
        updatedAt: '2026-10-01T10:00:00Z',
      })),
    },
  });

  const threadPages = () =>
    pages(fake.threads).map((page, index, all) => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: index < all.length - 1, endCursor: `cursor-${index}` },
              nodes: page.map((thread) => threadNode(thread)),
            },
          },
        },
      },
    }));

  const pullRequest = () => {
    if (fake.pullRequest === undefined) {
      throw new Error('no pull requests found');
    }

    const { number, state, author, headRefOid } = fake.pullRequest;

    return {
      number,
      url: `https://${repository}/pull/${number}`,
      state,
      author: { login: author, is_bot: false },
      headRefOid,
    };
  };

  const reviewItems = () =>
    fake.reviews.map((review) => ({
      id: review.id,
      user: restUser(review.author),
      state: review.state,
      body: review.body,
      html_url: `https://${repository}/pull/7#pullrequestreview-${review.id}`,
    }));

  const commentItems = () =>
    fake.comments.map((comment) => ({
      id: comment.id,
      user: restUser(comment.author),
      body: comment.body,
      html_url: `https://${repository}/pull/7#issuecomment-${comment.id}`,
    }));

  const responses: Record<ReadKey, () => unknown> = {
    user: () => ({ login: fake.viewer, type: 'User' }),
    'pr view': pullRequest,
    graphql: threadPages,
    reviews: () => pages(reviewItems()),
    comments: () => pages(commentItems()),
  };

  const writers: Record<WriteKey, (commandArguments: readonly string[]) => unknown> = {
    reply: postReply,
    resolve: resolveThread,
    'issue comment': postComment,
  };

  // A write that prints overridden output still takes effect, as when gh prints something odd.
  const respond = (key: CommandKey, commandArguments: readonly string[]) => {
    const value = isWriteKey(key) ? writers[key](commandArguments) : responses[key]();

    return overrides.get(key) ?? JSON.stringify(value);
  };

  const failsNow = (key: CommandKey) => {
    if (!isWriteKey(key)) {
      return failures.has(key);
    }

    writeAttempts += 1;

    return failures.has(key) || failingWrites.has(writeAttempts);
  };

  fake.exec = async (command, commandArguments) => {
    calls.push({ command, commandArguments });

    const key = command === 'gh' ? commandKey(commandArguments) : undefined;

    if (key === undefined) {
      return { code: 1, killed: false, stdout: '', stderr: `unknown command: ${command}` };
    }

    if (failsNow(key)) {
      return { code: 1, killed: false, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
    }

    try {
      const stdout = respond(key, commandArguments);

      return { code: 0, killed: false, stdout, stderr: '' };
    } catch (error) {
      return { code: 1, killed: false, stdout: '', stderr: (error as Error).message };
    }
  };

  return fake;
};
