export interface TicketComment {
  id: string;
  url: string;
  body: string;
  user: { id: string } | null;
}

export type CommentTarget =
  | { kind: 'add' }
  | { kind: 'update'; comment: TicketComment }
  | { kind: 'refuse'; ids: string[] };

export const decideCommentTarget = (input: {
  viewer: string;
  heading: string;
  savedId: string | undefined;
  comments: readonly TicketComment[];
}): CommentTarget => {
  const authored = input.comments.filter((comment) => comment.user?.id === input.viewer);
  const saved = authored.find((comment) => comment.id === input.savedId);

  if (saved !== undefined) {
    return { kind: 'update', comment: saved };
  }

  const matches = authored.filter((comment) => comment.body.split('\n')[0] === input.heading);

  if (matches.length > 1) {
    return { kind: 'refuse', ids: matches.map((comment) => comment.id) };
  }

  const matched = matches[0];

  return matched === undefined ? { kind: 'add' } : { kind: 'update', comment: matched };
};
