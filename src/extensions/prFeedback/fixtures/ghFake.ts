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

type CommandKey = 'user' | 'pr view' | 'graphql' | 'reviews' | 'comments';

export interface GhFake {
  exec: Exec;
  calls: FakeCall[];
  viewer: string;
  pullRequest: FakePullRequest | undefined;
  threads: FakeThread[];
  reviews: FakeReview[];
  comments: FakeComment[];
  overrideOutput: (key: CommandKey, stdout: string) => void;
  failCommand: (key: CommandKey) => void;
}

const repository = 'github.com/sQVe/tau';

const commentUrl = (id: number) => `https://${repository}/pull/7#discussion_r${id}`;

const restUser = (author: FakeAuthor | null) =>
  author === null ? null : { login: author.login, type: author.bot ? 'Bot' : 'User' };

const graphqlAuthor = (author: FakeAuthor | null) =>
  author === null ? null : { login: author.login, typename: author.bot ? 'Bot' : 'User' };

// `gh --paginate --slurp` prints an array of pages. One item per page exercises the merging.
const pages = <T>(items: T[]): T[][] => (items.length === 0 ? [[]] : items.map((item) => [item]));

const commandKey = (commandArguments: readonly string[]): CommandKey | undefined => {
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

export const createGhFake = (): GhFake => {
  const calls: FakeCall[] = [];
  const overrides = new Map<CommandKey, string>();
  const failures = new Set<CommandKey>();

  const fake: GhFake = {
    exec: async () => ({ code: 1, killed: false, stdout: '', stderr: 'not set up' }),
    calls,
    viewer: 'sqve',
    pullRequest: { number: 7, state: 'OPEN', author: 'sqve', headRefOid: 'abc123' },
    threads: [],
    reviews: [],
    comments: [],
    overrideOutput: (key, stdout) => {
      overrides.set(key, stdout);
    },
    failCommand: (key) => {
      failures.add(key);
    },
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

  const responses: Record<CommandKey, () => unknown> = {
    user: () => ({ login: fake.viewer, type: 'User' }),
    'pr view': pullRequest,
    graphql: threadPages,
    reviews: () => pages(reviewItems()),
    comments: () => pages(commentItems()),
  };

  fake.exec = async (command, commandArguments) => {
    calls.push({ command, commandArguments });

    const key = command === 'gh' ? commandKey(commandArguments) : undefined;

    if (key === undefined) {
      return { code: 1, killed: false, stdout: '', stderr: `unknown command: ${command}` };
    }

    if (failures.has(key)) {
      return { code: 1, killed: false, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
    }

    try {
      const stdout = overrides.get(key) ?? JSON.stringify(responses[key]());

      return { code: 0, killed: false, stdout, stderr: '' };
    } catch (error) {
      return { code: 1, killed: false, stdout: '', stderr: (error as Error).message };
    }
  };

  return fake;
};
