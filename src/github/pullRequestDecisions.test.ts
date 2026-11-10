import { expect, it } from 'vitest';

import { pickPullRequests } from './pullRequestDecisions.js';
import type { ListedPullRequest, PullRequest } from './pullRequestDecisions.js';

const fork = { host: 'github.com', owner: 'fork', name: 'tau' };

const listed = (
  number: number,
  state: string,
  owner = 'fork',
  name: string | null = 'tau',
): ListedPullRequest => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  state,
  title: 'Title',
  body: 'Body',
  author: { login: 'author' },
  baseRefName: 'main',
  isDraft: false,
  headRefOid: 'abc123',
  headRepositoryOwner: { login: owner },
  headRepository: name === null ? null : { name },
});

const numbers = (prs: readonly PullRequest[]) => prs.map((pr) => pr.number);

it.each([
  { prs: [], pr: null, closed: [] },
  { prs: [listed(1, 'OPEN')], pr: 1, closed: [] },
  { prs: [listed(1, 'OPEN', 'FORK')], pr: 1, closed: [] },
  { prs: [listed(1, 'OPEN', 'someone')], pr: null, closed: [] },
  { prs: [listed(1, 'OPEN', 'fork', 'TAU')], pr: 1, closed: [] },
  { prs: [listed(1, 'OPEN', 'fork', 'project')], pr: null, closed: [] },
  { prs: [listed(1, 'MERGED', 'fork', null)], pr: null, closed: [] },
  { prs: [listed(1, 'OPEN', 'fork', 'project'), listed(2, 'OPEN')], pr: 2, closed: [] },
  { prs: [listed(1, 'MERGED'), listed(2, 'CLOSED')], pr: null, closed: [1, 2] },
  { prs: [listed(1, 'CLOSED'), listed(2, 'OPEN'), listed(3, 'OPEN', 'x')], pr: 2, closed: [1] },
])('picks pull request $pr and closed $closed', ({ prs, pr, closed }) => {
  const choice = pickPullRequests(prs, fork);

  expect(choice.pr?.number ?? null).toBe(pr);
  expect(numbers(choice.closedPrs)).toEqual(closed);
});

it('refuses several open pull requests for one branch', () => {
  expect(() => pickPullRequests([listed(1, 'OPEN'), listed(2, 'OPEN')], fork)).toThrow(
    'Pull requests #1, #2 are all open for this branch.',
  );
});
