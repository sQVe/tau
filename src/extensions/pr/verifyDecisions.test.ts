import { expect, it } from 'vitest';

import { comparePullRequest } from './verifyDecisions.js';
import type { PullRequestFields } from './verifyDecisions.js';

const expected: PullRequestFields = {
  title: 'Add a feature',
  body: 'Adds it.\n',
  base: 'main',
  draft: true,
  head: 'abc123',
};

it.each([
  {
    case: 'a body without its trailing newline',
    actual: { ...expected, body: 'Adds it.' },
    differences: [],
  },
  {
    case: 'a body with more trailing newlines',
    actual: { ...expected, body: 'Adds it.\n\n\n' },
    differences: [],
  },
  {
    case: 'a different title',
    actual: { ...expected, title: 'Add another feature' },
    differences: [{ field: 'title', expected: 'Add a feature', actual: 'Add another feature' }],
  },
  {
    case: 'a different body',
    actual: { ...expected, body: 'Adds something else.' },
    differences: [{ field: 'body', expected: 'Adds it.\n', actual: 'Adds something else.' }],
  },
  {
    case: 'a body with a leading newline',
    actual: { ...expected, body: '\nAdds it.' },
    differences: [{ field: 'body', expected: 'Adds it.\n', actual: '\nAdds it.' }],
  },
  {
    case: 'a different base',
    actual: { ...expected, base: 'develop' },
    differences: [{ field: 'base', expected: 'main', actual: 'develop' }],
  },
  {
    case: 'a different draft status',
    actual: { ...expected, draft: false },
    differences: [{ field: 'draft', expected: true, actual: false }],
  },
  {
    case: 'a different head',
    actual: { ...expected, head: 'def456' },
    differences: [{ field: 'head', expected: 'abc123', actual: 'def456' }],
  },
  {
    case: 'every field different',
    actual: { title: 'Other', body: 'Other.', base: 'develop', draft: false, head: 'def456' },
    differences: [
      { field: 'title', expected: 'Add a feature', actual: 'Other' },
      { field: 'body', expected: 'Adds it.\n', actual: 'Other.' },
      { field: 'base', expected: 'main', actual: 'develop' },
      { field: 'draft', expected: true, actual: false },
      { field: 'head', expected: 'abc123', actual: 'def456' },
    ],
  },
])('compares $case with the approved preview', ({ actual, differences }) => {
  expect(comparePullRequest(expected, actual)).toEqual({ differences });
});
