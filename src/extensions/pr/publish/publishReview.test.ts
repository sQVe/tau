import { expect, it, onTestFinished } from 'vitest';

import {
  foreignInputOf,
  preparePublicationRun as prepareRun,
  publicationRepository as repository,
  publishedCommands,
  setUpPublication,
  writeRunFile,
} from '../fixtures/publicationRun.js';

const setUp = () => setUpPublication(onTestFinished);

const reviewRequest = (directory: string) =>
  ({ action: 'dryRun', kind: 'review', repository, directory, pr: 7 }) as const;

const reviewWrite = (contents: string) => ({
  key: 'api write',
  commandArguments: [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'POST',
    'repos/sQVe/tau/pulls/7/reviews',
    '--input',
    expect.stringMatching(/tau-publish-[^/\\]+[\\/]\d+-review\.json$/u),
  ],
  contents: Buffer.from(contents),
});

const submittedReview = `${JSON.stringify(
  {
    commit_id: 'abc123',
    event: 'COMMENT',
    body: 'Please fix the naming.',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Use a clearer name.' }],
  },
  null,
  2,
)}\n`;

const longReviewBody =
  'This review body explains the purpose of the change, the scope it covers, the limits a reader should know, the checks that ran, the evidence behind each claim, and the decisions the author made, so a reviewer can follow it without asking for more context.';

const pendingReview = `${JSON.stringify(
  {
    commit_id: 'abc123',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Use a clearer name.' }],
  },
  null,
  2,
)}\n`;

it('posts a submitted review with inline comments in one call', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  await writeRunFile(directory, 'review.json', submittedReview);
  const request = reviewRequest(directory);
  const dryRun = await run(request);

  const published = await run({ ...request, action: 'publish', token: dryRun.token });

  expect(fake.writes).toEqual([reviewWrite(submittedReview)]);

  expect(published.url).toBe('https://github.com/sQVe/tau/pull/7#pullrequestreview-1');
  expect(publishedCommands(fake)).toEqual(['api --hostname']);
});

it('reports review findings per prose field, not over the JSON', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const commentBody = 'The naming here is unclear \u2014 please rename it.';

  await writeRunFile(
    directory,
    'review.json',
    `${JSON.stringify(
      { body: longReviewBody, comments: [{ path: 'src/a.ts', line: 3, body: commentBody }] },
      null,
      2,
    )}\n`,
  );

  const dryRun = await run(reviewRequest(directory));

  expect(dryRun.findings).toEqual([
    expect.objectContaining({
      file: 'review.json',
      field: 'body',
      rule: 'longSentence',
      line: 1,
    }),
    expect.objectContaining({
      file: 'review.json',
      field: 'comments[0].body',
      rule: 'emDash',
      line: 1,
    }),
  ]);

  expect(dryRun.findings.map((finding) => finding.excerpt)).toEqual([
    expect.stringMatching(/^This review body explains the purpose/u),
    commentBody,
  ]);

  expect(JSON.stringify(dryRun['findings'])).not.toContain('commit_id');
  expect(fake.calls).toEqual([]);
});

it('posts a pending review without an event in one call', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  await writeRunFile(directory, 'review.json', pendingReview);

  const request = reviewRequest(directory);
  const dryRun = await run(request);

  await run({ ...request, action: 'publish', token: dryRun.token });

  expect(fake.writes).toEqual([reviewWrite(pendingReview)]);

  expect(fake.calls).toHaveLength(1);
});

it('refuses a review comment with neither line nor position and names its index', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  const review = {
    comments: [
      { path: 'src/a.ts', line: 3, body: 'Fine.' },
      { path: 'src/b.ts', body: 'No position.' },
    ],
  };

  await writeRunFile(directory, 'review.json', `${JSON.stringify(review, null, 2)}\n`);

  await expect(run(reviewRequest(directory))).rejects.toThrow(
    'review.json comments[1] needs line or position.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses a reply comment as an unknown field', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const review = { comments: [{ path: 'src/a.ts', body: 'Agreed.', in_reply_to: 101 }] };

  await writeRunFile(directory, 'review.json', `${JSON.stringify(review, null, 2)}\n`);

  await expect(run(reviewRequest(directory))).rejects.toThrow(
    /review\.json has a bad field: \/comments\/0\/in_reply_to/u,
  );

  expect(fake.calls).toEqual([]);
});

it('posts a review comment that carries only position', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const review = { comments: [{ path: 'src/a.ts', position: 3, body: 'Fine.' }] };
  const contents = `${JSON.stringify(review, null, 2)}\n`;

  await writeRunFile(directory, 'review.json', contents);

  const request = reviewRequest(directory);
  const dryRun = await run(request);
  const published = await run({ ...request, action: 'publish', token: dryRun.token });

  expect(fake.writes).toEqual([reviewWrite(contents)]);

  expect(published.url).toBe('https://github.com/sQVe/tau/pull/7#pullrequestreview-1');
});

it('refuses a COMMENT review without a body', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(
    directory,
    'review.json',
    `${JSON.stringify({ event: 'COMMENT', comments: [{ path: 'src/a.ts', line: 3, body: 'Fine.' }] })}\n`,
  );

  await expect(run(reviewRequest(directory))).rejects.toThrow(
    'review.json needs a body for a COMMENT event.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses a REQUEST_CHANGES review without a body', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(
    directory,
    'review.json',
    `${JSON.stringify({
      event: 'REQUEST_CHANGES',
      comments: [{ path: 'src/a.ts', line: 3, body: 'Fine.' }],
    })}\n`,
  );

  await expect(run(reviewRequest(directory))).rejects.toThrow(
    'review.json needs a body for a REQUEST_CHANGES event.',
  );

  expect(fake.calls).toEqual([]);
});

it('accepts an APPROVE review without a body', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'review.json', `${JSON.stringify({ event: 'APPROVE' })}\n`);

  const dryRun = await run(reviewRequest(directory));

  expect(dryRun.findings).toEqual([]);
  expect(fake.calls).toEqual([]);
});

it('refuses a review comment with a blank body', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(
    directory,
    'review.json',
    `${JSON.stringify({
      event: 'COMMENT',
      body: 'Please fix the naming.',
      comments: [{ path: 'src/a.ts', line: 3, body: '   ' }],
    })}\n`,
  );

  await expect(run(reviewRequest(directory))).rejects.toThrow(
    'review.json comments[0] needs a body.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses a review comment that sets both line and position', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(
    directory,
    'review.json',
    `${JSON.stringify({
      event: 'COMMENT',
      body: 'Please fix the naming.',
      comments: [{ path: 'src/a.ts', line: 3, position: 2, body: 'Use a clearer name.' }],
    })}\n`,
  );

  await expect(run(reviewRequest(directory))).rejects.toThrow(
    'review.json comments[0] cannot take both line and position.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses start_line without line', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(
    directory,
    'review.json',
    `${JSON.stringify({
      event: 'COMMENT',
      body: 'Please fix the naming.',
      comments: [{ path: 'src/a.ts', body: 'Use a clearer name.', start_line: 2 }],
    })}\n`,
  );

  await expect(run(reviewRequest(directory))).rejects.toThrow(
    'review.json comments[0] needs line when start_line is set.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses start_side without start_line', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(
    directory,
    'review.json',
    `${JSON.stringify({
      event: 'COMMENT',
      body: 'Please fix the naming.',
      comments: [{ path: 'src/a.ts', line: 3, body: 'Use a clearer name.', start_side: 'RIGHT' }],
    })}\n`,
  );

  await expect(run(reviewRequest(directory))).rejects.toThrow(
    'review.json comments[0] needs start_line when start_side is set.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses review.json that is not JSON', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'review.json', '{');

  await expect(run(reviewRequest(directory))).rejects.toThrow(/review\.json is not JSON/u);

  expect(fake.calls).toEqual([]);
});

it('names the review.json field that is not valid', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'review.json', '{"event":"MERGE"}\n');

  await expect(run(reviewRequest(directory))).rejects.toThrow(/review\.json .*\/event/u);

  expect(fake.calls).toEqual([]);
});

it.each(['file', 'base', 'head', 'draft'] as const)(
  'refuses %s for a review in the dry run',
  async (name) => {
    const { fake, run } = await setUp();
    const directory = await prepareRun(run);
    const foreignInput = foreignInputOf(name);

    await expect(run({ ...reviewRequest(directory), ...foreignInput })).rejects.toThrow(
      `dryRun with kind review cannot take ${name}.`,
    );

    expect(fake.calls).toEqual([]);
  },
);

it.each(['file', 'base', 'head', 'draft'] as const)(
  'refuses %s for a review in publish',
  async (name) => {
    const { fake, run } = await setUp();
    const directory = await prepareRun(run);

    await writeRunFile(directory, 'review.json', `${JSON.stringify({ event: 'APPROVE' })}\n`);

    const dryRun = await run(reviewRequest(directory));
    const foreignInput = foreignInputOf(name);

    await expect(
      run({ ...reviewRequest(directory), action: 'publish', token: dryRun.token, ...foreignInput }),
    ).rejects.toThrow(`publish with kind review cannot take ${name}.`);

    expect(fake.calls).toEqual([]);
  },
);
