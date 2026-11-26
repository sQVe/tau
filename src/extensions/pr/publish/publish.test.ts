import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import type { GhFake } from '../../../../tests/prGhFake.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { createPublicationTool } from '../fixtures/publicationRepository.js';
import type { PrInput } from '../tool.js';

const repository = 'github.com/sQVe/tau';

const setUp = () => createPublicationTool(onTestFinished);

const prepareRun = async (run: (input: PrInput) => Promise<Record<string, unknown>>) => {
  const { directory } = await run({ action: 'prepare' });

  return String(directory);
};

const writeRunFile = async (directory: string, file: string, contents: string) => {
  const path = join(directory, file);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);

  return path;
};

const dryRunPullRequest = (directory: string) =>
  ({
    action: 'dryRun',
    kind: 'pullRequest',
    repository,
    directory,
    base: 'main',
    head: 'feature',
    draft: true,
  }) as const;

const publishedCommands = (fake: GhFake) =>
  fake.calls.map((call) => call.commandArguments.slice(0, 2).join(' '));

it('publishes a new pull request with the approved title, body, base, head, and draft', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const body = await writeRunFile(directory, 'body.md', 'Adds it.\n');

  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const dryRun = await run(dryRunPullRequest(directory));

  expect(fake.calls).toEqual([]);
  expect(dryRun).toMatchObject({ findings: [] });

  const published = await run({
    ...dryRunPullRequest(directory),
    action: 'publish',
    token: String(dryRun['token']),
  });

  expect(fake.writes).toEqual([
    {
      key: 'pr create',
      commandArguments: [
        'pr',
        'create',
        '--repo',
        'github.com/sQVe/tau',
        '--base',
        'main',
        '--head',
        'feature',
        '--title',
        'Add a feature',
        '--body-file',
        body,
        '--draft',
      ],
      contents: Buffer.from('Adds it.\n'),
    },
  ]);

  expect(published['url']).toBe('https://github.com/sQVe/tau/pull/8');
  expect(publishedCommands(fake)).toEqual(['pr create']);
});

it('publishes an edited pull request with the approved title and body', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const body = await writeRunFile(directory, 'body.md', 'Adds it.\n');

  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = {
    action: 'dryRun',
    kind: 'pullRequest',
    repository,
    directory,
    pr: 7,
  } as const;

  const dryRun = await run(request);

  const published = await run({ ...request, action: 'publish', token: String(dryRun['token']) });

  expect(fake.writes).toEqual([
    {
      key: 'pr edit',
      commandArguments: [
        'pr',
        'edit',
        '7',
        '--repo',
        'github.com/sQVe/tau',
        '--title',
        'Add a feature',
        '--body-file',
        body,
      ],
      contents: Buffer.from('Adds it.\n'),
    },
  ]);

  expect(published['url']).toBeNull();
  expect(publishedCommands(fake)).toEqual(['pr edit']);
});

it('publishes a comment file under bots', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const file = await writeRunFile(directory, 'bots/0.md', 'Looks good.\n');

  const request = {
    action: 'dryRun',
    kind: 'comment',
    repository,
    directory,
    pr: 1,
    file: 'bots/0.md',
  } as const;

  const dryRun = await run(request);

  const published = await run({ ...request, action: 'publish', token: String(dryRun['token']) });

  expect(fake.writes).toEqual([
    {
      key: 'pr comment',
      commandArguments: [
        'pr',
        'comment',
        '1',
        '--repo',
        'github.com/sQVe/tau',
        '--body-file',
        file,
      ],
      contents: Buffer.from('Looks good.\n'),
    },
  ]);

  expect(published['url']).toBe('https://github.com/sQVe/tau/pull/1#issuecomment-1');
  expect(publishedCommands(fake)).toEqual(['pr comment']);
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

it('posts a submitted review with inline comments in one call', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const file = await writeRunFile(directory, 'review.json', submittedReview);
  const request = { action: 'dryRun', kind: 'review', repository, directory, pr: 7 } as const;
  const dryRun = await run(request);

  const published = await run({ ...request, action: 'publish', token: String(dryRun['token']) });

  expect(fake.writes).toEqual([
    {
      key: 'api post',
      commandArguments: [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        'repos/sQVe/tau/pulls/7/reviews',
        '--input',
        file,
      ],
      contents: Buffer.from(submittedReview),
    },
  ]);

  expect(published['url']).toBe('https://github.com/sQVe/tau/pull/7#pullrequestreview-1');
  expect(publishedCommands(fake)).toEqual(['api --hostname']);
});

const longReviewBody =
  'This review body explains the purpose of the change, the scope it covers, the limits a reader should know, the checks that ran, the evidence behind each claim, and the decisions the author made, so a reviewer can follow it without asking for more context.';

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

  const dryRun = await run({ action: 'dryRun', kind: 'review', repository, directory, pr: 7 });

  expect(dryRun['findings']).toEqual([
    {
      file: 'review.json',
      field: 'body',
      rule: 'longSentence',
      line: 1,
      excerpt: `${longReviewBody.slice(0, 100)}...`,
    },
    {
      file: 'review.json',
      field: 'comments[0].body',
      rule: 'emDash',
      line: 1,
      excerpt: commentBody,
    },
  ]);

  expect(JSON.stringify(dryRun['findings'])).not.toContain('commit_id');
  expect(fake.calls).toEqual([]);
});

const pendingReview = `${JSON.stringify(
  {
    commit_id: 'abc123',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Use a clearer name.' }],
  },
  null,
  2,
)}\n`;

it('posts a pending review without an event in one call', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  await writeRunFile(directory, 'review.json', pendingReview);

  const request = { action: 'dryRun', kind: 'review', repository, directory, pr: 7 } as const;
  const dryRun = await run(request);

  await run({ ...request, action: 'publish', token: String(dryRun['token']) });

  expect(fake.writes).toEqual([
    {
      key: 'api post',
      commandArguments: [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        'repos/sQVe/tau/pulls/7/reviews',
        '--input',
        join(directory, 'review.json'),
      ],
      contents: Buffer.from(pendingReview),
    },
  ]);

  expect(fake.calls).toHaveLength(1);
});

it('creates a pull request without --draft when draft is false', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const body = await writeRunFile(directory, 'body.md', 'Adds it.\n');

  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = { ...dryRunPullRequest(directory), draft: false };
  const dryRun = await run(request);

  await run({ ...request, action: 'publish', token: String(dryRun['token']) });

  expect(fake.writes[0]?.commandArguments).toEqual([
    'pr',
    'create',
    '--repo',
    'github.com/sQVe/tau',
    '--base',
    'main',
    '--head',
    'feature',
    '--title',
    'Add a feature',
    '--body-file',
    body,
  ]);
});

it('refuses a dry run or publish that lacks a required input', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');
  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  await expect(run({ action: 'dryRun', repository, directory })).rejects.toThrow(
    'dryRun needs kind',
  );

  await expect(
    run({ action: 'dryRun', kind: 'pullRequest', repository, directory }),
  ).rejects.toThrow('dryRun needs base.');

  await expect(
    run({ action: 'dryRun', kind: 'pullRequest', repository, directory, base: 'main' }),
  ).rejects.toThrow('dryRun needs head.');

  await expect(run({ ...dryRunPullRequest(directory), action: 'publish' })).rejects.toThrow(
    'publish needs token from dryRun.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses a whitespace-only title.md at the dry run', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');
  await writeRunFile(directory, 'title.md', '   \n');

  await expect(run(dryRunPullRequest(directory))).rejects.toThrow('title.md must not be empty.');

  expect(fake.calls).toEqual([]);
});

it('trims base and head and refuses a whitespace-only value', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const body = await writeRunFile(directory, 'body.md', 'Adds it.\n');

  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  await expect(run({ ...dryRunPullRequest(directory), base: '  ' })).rejects.toThrow(
    'dryRun needs base.',
  );

  await expect(run({ ...dryRunPullRequest(directory), head: '\t' })).rejects.toThrow(
    'dryRun needs head.',
  );

  expect(fake.calls).toEqual([]);

  const request = { ...dryRunPullRequest(directory), base: ' main ', head: ' feature ' };
  const dryRun = await run(request);

  await run({ ...request, action: 'publish', token: String(dryRun['token']) });

  expect(fake.writes[0]?.commandArguments).toEqual([
    'pr',
    'create',
    '--repo',
    'github.com/sQVe/tau',
    '--base',
    'main',
    '--head',
    'feature',
    '--title',
    'Add a feature',
    '--body-file',
    body,
    '--draft',
  ]);
});

it('refuses to publish when only title.md changed and names it', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');
  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);

  await writeRunFile(directory, 'title.md', 'Another title\n');

  await expect(
    run({ ...request, action: 'publish', token: String(dryRun['token']) }),
  ).rejects.toThrow(/title\.md changed since the dry run/u);

  expect(fake.calls).toEqual([]);
});

it('refuses to publish a token from another create target and sends nothing', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');
  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);
  const changes = [{ base: 'develop' }, { head: 'other' }, { draft: false }];

  for (const change of changes) {
    await expect(
      run({ ...request, ...change, action: 'publish', token: String(dryRun['token']) }),
    ).rejects.toThrow('The token covers a different publication target');
  }

  expect(fake.calls).toEqual([]);
});

it('refuses to publish a token from another pull request and sends nothing', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');
  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = { ...dryRunPullRequest(directory), pr: 7 };
  const dryRun = await run(request);

  await expect(
    run({ ...request, action: 'publish', pr: 8, token: String(dryRun['token']) }),
  ).rejects.toThrow('The token covers a different publication target');

  expect(fake.calls).toEqual([]);
});

it('refuses to publish a token from another run directory and sends nothing', async () => {
  const { fake, run } = await setUp();
  const first = await prepareRun(run);
  const second = await prepareRun(run);

  for (const directory of [first, second]) {
    await writeRunFile(directory, 'body.md', 'Adds it.\n');
    await writeRunFile(directory, 'title.md', 'Add a feature\n');
  }

  const dryRun = await run(dryRunPullRequest(first));

  await expect(
    run({
      ...dryRunPullRequest(second),
      action: 'publish',
      token: String(dryRun['token']),
    }),
  ).rejects.toThrow('The token covers a different publication target');

  expect(fake.calls).toEqual([]);
});

it('refuses a run directory without body.md', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  await expect(run(dryRunPullRequest(directory))).rejects.toThrow('No body.md at');

  expect(fake.calls).toEqual([]);
});

it('refuses to publish when a file changed after the dry run and sends nothing', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  await writeRunFile(directory, 'body.md', 'Adds it.\n');
  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);

  await writeRunFile(directory, 'body.md', 'Adds something else.\n');

  await expect(
    run({ ...request, action: 'publish', token: String(dryRun['token']) }),
  ).rejects.toThrow(/body\.md changed since the dry run/u);

  expect(fake.calls).toEqual([]);
});

it('returns the em dash finding from the dry run and publishes with it', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const body = await writeRunFile(directory, 'body.md', 'Adds it \u2014 now.\n');

  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);

  expect(dryRun['findings']).toEqual([
    { file: 'body.md', rule: 'emDash', line: 1, excerpt: 'Adds it \u2014 now.' },
  ]);

  await run({ ...request, action: 'publish', token: String(dryRun['token']) });

  expect(fake.writes).toHaveLength(1);
  expect(fake.writes[0]?.contents).toEqual(Buffer.from('Adds it \u2014 now.\n'));
  expect(fake.writes[0]?.commandArguments).toContain(body);
});

it('names the review.json field that is not valid', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'review.json', '{"event":"MERGE"}\n');

  await expect(
    run({ action: 'dryRun', kind: 'review', repository, directory, pr: 7 }),
  ).rejects.toThrow(/review\.json .*\/event/u);

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file that is an absolute path', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const file = await writeRunFile(directory, 'comment.md', 'Looks good.\n');

  await expect(
    run({ action: 'dryRun', kind: 'comment', repository, directory, pr: 7, file }),
  ).rejects.toThrow('The comment file must be relative to the run directory');

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file that climbs out of the run directory', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: '../body.md',
    }),
  ).rejects.toThrow('The comment file must stay in the run directory');

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file path with a backslash', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: 'bots\\0.md',
    }),
  ).rejects.toThrow('The comment file must not contain a backslash');

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file that is a directory', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const path = join(directory, 'bots');

  await mkdir(path);

  await expect(
    run({ action: 'dryRun', kind: 'comment', repository, directory, pr: 7, file: 'bots' }),
  ).rejects.toThrow(`not a regular file: ${path}`);

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file that is a symlink', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const outside = temporaryDirectory(onTestFinished, 'tau-pr-outside-');

  await writeFile(join(outside, 'comment.md'), 'Looks good.\n');
  await symlink(join(outside, 'comment.md'), join(directory, 'comment.md'));

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: 'comment.md',
    }),
  ).rejects.toThrow('through a symlink');

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file with another hard link', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const outside = temporaryDirectory(onTestFinished, 'tau-pr-outside-');

  await writeFile(join(outside, 'comment.md'), 'Looks good.\n');
  await link(join(outside, 'comment.md'), join(directory, 'comment.md'));

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: 'comment.md',
    }),
  ).rejects.toThrow('another hard link');

  expect(fake.calls).toEqual([]);
});
