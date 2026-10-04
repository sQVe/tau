// The query reads `__typename` under the alias `typename`.
export interface GraphqlAuthor {
  login: string;
  typename: string;
}

export interface RestUser {
  login: string;
  type: string;
}

export interface ThreadCommentNode {
  databaseId: number;
  author: GraphqlAuthor | null;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  comments: { pageInfo: { hasNextPage: boolean }; nodes: ThreadCommentNode[] };
}

export interface ReviewItem {
  id: number;
  user: RestUser | null;
  state: string;
  body: string;
  html_url: string;
}

export interface IssueCommentItem {
  id: number;
  user: RestUser | null;
  body: string;
  html_url: string;
}

interface Author {
  author: string | null;
  isBot: boolean;
}

interface ThreadComment extends Author {
  id: number;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface Thread {
  id: string;
  path: string;
  line: number | null;
  isOutdated: boolean;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  replyTo: number;
  fromPerson: boolean;
  startedByViewer: boolean;
  comments: ThreadComment[];
}

export interface Review extends Author {
  id: number;
  state: string;
  body: string;
  url: string;
}

export interface Comment extends Author {
  id: number;
  body: string;
  url: string;
}

export interface Feedback {
  viewer: string;
  threads: ThreadNode[];
  reviews: ReviewItem[];
  comments: IssueCommentItem[];
}

export interface StateEntry {
  kind: 'thread' | 'review' | 'comment';
  id: number;
  author: string | null;
  body: string;
}

// GitHub alone says what is a bot. A missing author is a deleted account, which was a person.
const fromGraphqlAuthor = (author: GraphqlAuthor | null): Author => ({
  author: author?.login ?? null,
  isBot: author?.typename === 'Bot',
});

const fromRestUser = (user: RestUser | null): Author => ({
  author: user?.login ?? null,
  isBot: user?.type === 'Bot',
});

const toThreadComment = (node: ThreadCommentNode): ThreadComment => {
  const { author, isBot } = fromGraphqlAuthor(node.author);

  return {
    id: node.databaseId,
    author,
    isBot,
    body: node.body,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
};

const toThread = (viewer: string, node: ThreadNode): Thread => {
  const comments = node.comments.nodes.map((comment) => toThreadComment(comment));
  const [first] = comments;

  if (first === undefined) {
    throw new Error(`Review thread ${node.id} has no comments.`);
  }

  return {
    id: node.id,
    path: node.path,
    line: node.line,
    isOutdated: node.isOutdated,
    viewerCanReply: node.viewerCanReply,
    viewerCanResolve: node.viewerCanResolve,
    replyTo: first.id,
    fromPerson: comments.some((comment) => !comment.isBot),
    startedByViewer: first.author === viewer,
    comments,
  };
};

// A thread with more comments than one page holds would hide some from the reader and the token.
export const rejectLongThreads = (threads: readonly ThreadNode[]): void => {
  const long = threads.find((thread) => thread.comments.pageInfo.hasNextPage);

  if (long !== undefined) {
    const url = long.comments.nodes[0]?.url ?? long.id;

    throw new Error(`The review thread ${url} is too long to read in full.`);
  }
};

export const unresolvedThreads = (feedback: Feedback): Thread[] =>
  feedback.threads
    .filter((thread) => !thread.isResolved)
    .map((thread) => toThread(feedback.viewer, thread));

export const reviewsWithBody = (feedback: Feedback): Review[] =>
  feedback.reviews
    .filter((review) => review.body.trim() !== '')
    .map((review) => {
      const { author, isBot } = fromRestUser(review.user);

      return {
        id: review.id,
        author,
        isBot,
        state: review.state,
        body: review.body,
        url: review.html_url,
      };
    });

export const conversationComments = (feedback: Feedback): Comment[] =>
  feedback.comments.map((comment) => {
    const { author, isBot } = fromRestUser(comment.user);

    return { id: comment.id, author, isBot, body: comment.body, url: comment.html_url };
  });

const isOtherPerson = (viewer: string, author: Author) => !author.isBot && author.author !== viewer;

const compareEntries = (left: StateEntry, right: StateEntry) =>
  left.kind === right.kind ? left.id - right.id : left.kind.localeCompare(right.kind);

const toStateEntry = (
  kind: StateEntry['kind'],
  { id, author, body }: Author & { id: number; body: string },
): StateEntry => ({ kind, id, author, body });

// Lists every comment by a person other than the viewer, resolved threads included, so a hash of
// the list changes when such a comment is added, edited, or deleted.
export const stateEntries = (feedback: Feedback): StateEntry[] => {
  const threadComments = feedback.threads.flatMap((thread) =>
    thread.comments.nodes.map((node) => toThreadComment(node)),
  );

  const sources = [
    ...threadComments.map((comment) => ({ kind: 'thread' as const, source: comment })),
    ...reviewsWithBody(feedback).map((review) => ({ kind: 'review' as const, source: review })),
    ...conversationComments(feedback).map((comment) => ({
      kind: 'comment' as const,
      source: comment,
    })),
  ];

  return sources
    .filter(({ source }) => isOtherPerson(feedback.viewer, source))
    .map(({ kind, source }) => toStateEntry(kind, source))
    .toSorted(compareEntries);
};
