import type { Operation, QueryOperation } from './linearRequestFake.js';

interface FakeComment {
  id: string;
  ticket: string;
  body: string;
  user: { id: string } | null;
  url: string;
}

interface Ticket {
  identifier: string;
  title: string;
  assigneeId: string | null;
  creatorId: string | null;
  state: Readonly<{ type: string; name: string }>;
  pullRequests: string[];
}

type CommentOperation = Extract<
  QueryOperation,
  { name: 'comments' | 'commentCreate' | 'commentUpdate' | 'cancel' }
>;

interface CommentFake {
  comments: Map<string, FakeComment>;
  addComment: (input: Pick<FakeComment, 'ticket' | 'body'> & Partial<FakeComment>) => FakeComment;
  respond: (operation: CommentOperation | Extract<Operation, { kind: 'cancel' }>) => unknown;
  limitComments: (count: number) => void;
}

export const createCommentFake = (
  issues: Map<string, Ticket>,
  attachmentLimit: () => number,
): CommentFake => {
  const comments = new Map<string, FakeComment>();
  let limit = Number.POSITIVE_INFINITY;

  const addComment = (input: Pick<FakeComment, 'ticket' | 'body'> & Partial<FakeComment>) => {
    const id = input.id ?? `comment-${comments.size + 1}`;

    const saved: FakeComment = {
      id,
      url: `https://linear.app/comment/${id}`,
      user: { id: 'user-viewer' },
      ...input,
    };

    comments.set(id, saved);

    return saved;
  };

  const respond = (operation: CommentOperation | Extract<Operation, { kind: 'cancel' }>) => {
    if (operation.kind === 'cancel') {
      const issue = issues.get(operation.identifier);

      if (issue === undefined) {
        throw new Error(`Missing issue ${operation.identifier}`);
      }

      issue.state = { type: 'canceled', name: 'Canceled' };

      return '';
    }

    if (operation.name === 'commentCreate') {
      const ticket = [...issues.values()].find(
        (issue) => `id-${issue.identifier}` === operation.variables.issue,
      );

      if (ticket === undefined) {
        throw new Error('Missing comment issue');
      }

      const saved = addComment({ ticket: ticket.identifier, body: operation.variables.body });

      return { commentCreate: { success: true, comment: saved } };
    }

    if (operation.name === 'commentUpdate') {
      const saved = comments.get(operation.variables.id);

      if (saved?.user?.id !== 'user-viewer') {
        throw new Error('Comment is missing or belongs to another user');
      }

      saved.body = operation.variables.body;

      return { commentUpdate: { success: true, comment: saved } };
    }

    const issue = issues.get(operation.variables.id);

    if (issue === undefined) {
      return { viewer: { id: 'user-viewer' }, issue: null };
    }

    const matches = [...comments.values()].filter((entry) => entry.ticket === issue.identifier);

    return {
      viewer: { id: 'user-viewer' },
      issue: {
        id: `id-${issue.identifier}`,
        identifier: issue.identifier,
        title: issue.title,
        assignee: issue.assigneeId === null ? null : { id: issue.assigneeId },
        creator: issue.creatorId === null ? null : { id: issue.creatorId },
        state: issue.state,
        attachments: {
          nodes: issue.pullRequests.slice(0, attachmentLimit()).map((url) => ({ url })),
          pageInfo: { hasNextPage: issue.pullRequests.length > attachmentLimit() },
        },
        comments: {
          nodes: matches.slice(0, limit),
          pageInfo: { hasNextPage: matches.length > limit },
        },
      },
    };
  };

  return {
    comments,
    addComment,
    respond,
    limitComments: (count: number): void => {
      limit = count;
    },
  };
};
