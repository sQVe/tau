import { expect, it } from 'vitest';

import { stateEntries, stateText } from './threads.js';
import type {
  Feedback,
  GraphqlAuthor,
  RestUser,
  ThreadCommentNode,
  ThreadNode,
} from './threads.js';

const viewer = 'sqve';

const graphqlPerson: GraphqlAuthor = { login: 'reviewer', typename: 'User' };
const graphqlBot: GraphqlAuthor = { login: 'coderabbitai', typename: 'Bot' };
const graphqlViewer: GraphqlAuthor = { login: viewer, typename: 'User' };
const restPerson: RestUser = { login: 'reviewer', type: 'User' };
const restBot: RestUser = { login: 'coderabbitai', type: 'Bot' };
const restViewer: RestUser = { login: viewer, type: 'User' };

const threadComment = (
  databaseId: number,
  author: GraphqlAuthor | null,
  body = 'Rename this.',
): ThreadCommentNode => ({
  databaseId,
  author,
  body,
  url: `https://github.com/sQVe/tau/pull/7#discussion_r${databaseId}`,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
});

const thread = (comments: ThreadCommentNode[], isResolved = false): ThreadNode => ({
  id: 'thread-1',
  isResolved,
  isOutdated: false,
  path: 'src/tau.ts',
  line: 12,
  viewerCanReply: true,
  viewerCanResolve: true,
  comments: { pageInfo: { hasNextPage: false }, nodes: comments },
});

const review = (id: number, user: RestUser | null, body = 'Looks close.') => ({
  id,
  user,
  state: 'COMMENTED',
  body,
  html_url: `https://github.com/sQVe/tau/pull/7#pullrequestreview-${id}`,
});

const comment = (id: number, user: RestUser | null, body = 'Can this land today?') => ({
  id,
  user,
  body,
  html_url: `https://github.com/sQVe/tau/pull/7#issuecomment-${id}`,
});

const base: Feedback = {
  viewer,
  threads: [thread([threadComment(101, graphqlPerson)])],
  reviews: [review(201, restPerson)],
  comments: [comment(301, restPerson)],
};

const withThreadComments = (comments: ThreadCommentNode[], isResolved = false): Feedback => ({
  ...base,
  threads: [thread(comments, isResolved)],
});

it.each([
  {
    change: 'a person adds a thread comment',
    after: withThreadComments([
      threadComment(101, graphqlPerson),
      threadComment(102, graphqlPerson),
    ]),
    changes: true,
  },
  {
    change: 'a person edits a thread comment',
    after: withThreadComments([threadComment(101, graphqlPerson, 'Rename this, please.')]),
    changes: true,
  },
  {
    change: 'a person deletes a thread comment',
    after: { ...base, threads: [] },
    changes: true,
  },
  {
    change: 'a deleted account adds a thread comment',
    after: withThreadComments([threadComment(101, graphqlPerson), threadComment(102, null)]),
    changes: true,
  },
  {
    change: 'a person comments in a resolved thread',
    after: withThreadComments(
      [threadComment(101, graphqlPerson), threadComment(102, graphqlPerson)],
      true,
    ),
    changes: true,
  },
  {
    change: 'a person adds a review',
    after: { ...base, reviews: [review(201, restPerson), review(202, restPerson)] },
    changes: true,
  },
  {
    change: 'a person edits a review',
    after: { ...base, reviews: [review(201, restPerson, 'Looks done.')] },
    changes: true,
  },
  {
    change: 'a person adds a conversation comment',
    after: { ...base, comments: [comment(301, restPerson), comment(302, restPerson)] },
    changes: true,
  },
  {
    change: 'a person edits a conversation comment',
    after: { ...base, comments: [comment(301, restPerson, 'Ship it.')] },
    changes: true,
  },
  {
    change: 'a person deletes a conversation comment',
    after: { ...base, comments: [] },
    changes: true,
  },
  {
    change: 'a bot adds a thread comment',
    after: withThreadComments([threadComment(101, graphqlPerson), threadComment(102, graphqlBot)]),
    changes: false,
  },
  {
    change: 'the viewer adds a thread comment',
    after: withThreadComments([
      threadComment(101, graphqlPerson),
      threadComment(102, graphqlViewer),
    ]),
    changes: false,
  },
  {
    change: 'the viewer resolves the thread',
    after: withThreadComments([threadComment(101, graphqlPerson)], true),
    changes: false,
  },
  {
    change: 'a bot adds a review',
    after: { ...base, reviews: [review(201, restPerson), review(202, restBot)] },
    changes: false,
  },
  {
    change: 'a person approves without a body',
    after: { ...base, reviews: [review(201, restPerson), review(202, restPerson, '')] },
    changes: false,
  },
  {
    change: 'the viewer adds a conversation comment',
    after: { ...base, comments: [comment(301, restPerson), comment(302, restViewer)] },
    changes: false,
  },
  {
    change: 'a bot adds a conversation comment',
    after: { ...base, comments: [comment(301, restPerson), comment(302, restBot)] },
    changes: false,
  },
])('when $change, the state changes: $changes', ({ after, changes }) => {
  const changed = JSON.stringify(stateEntries(after)) !== JSON.stringify(stateEntries(base));

  expect(changed).toBe(changes);
});

it.each([
  { other: 'github.com/sQVe/tau#8', differs: true },
  { other: 'github.com/sQVe/other#7', differs: true },
  { other: 'ghe.example.com/sQVe/tau#7', differs: true },
  { other: 'github.com/sQVe/tau#7', differs: false },
])('the state of $other differs from github.com/sQVe/tau#7: $differs', ({ other, differs }) => {
  const changed = stateText(other, base) !== stateText('github.com/sQVe/tau#7', base);

  expect(changed).toBe(differs);
});
