import { expect, it } from 'vitest';

import { publishedUrl } from './publishExecution.js';

const repository = 'github.com/sQVe/tau';

it('returns the pull request URL after another https line', () => {
  const stdout = 'https://example.com/other\nhttps://github.com/sQVe/tau/pull/8\n';

  expect(publishedUrl('pullRequest', repository, stdout)).toBe(
    'https://github.com/sQVe/tau/pull/8',
  );
});

it('returns the comment URL for a comment', () => {
  const stdout = 'https://github.com/sQVe/tau/pull/1#issuecomment-1\n';

  expect(publishedUrl('comment', repository, stdout)).toBe(
    'https://github.com/sQVe/tau/pull/1#issuecomment-1',
  );
});

it('returns the review URL from its JSON', () => {
  const stdout = JSON.stringify({
    html_url: 'https://github.com/sQVe/tau/pull/7#pullrequestreview-1',
  });

  expect(publishedUrl('review', repository, stdout)).toBe(
    'https://github.com/sQVe/tau/pull/7#pullrequestreview-1',
  );
});

it('returns null when no URL matches the repository and kind', () => {
  expect(
    publishedUrl('pullRequest', repository, 'https://github.com/sQVe/other/pull/8\n'),
  ).toBeNull();

  expect(
    publishedUrl(
      'review',
      repository,
      JSON.stringify({ html_url: 'https://github.com/sQVe/tau/pull/7' }),
    ),
  ).toBeNull();
});
