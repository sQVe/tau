import { expect, it, onTestFinished } from 'vitest';

import {
  dryRunPullRequest,
  dryRunPullRequestEdit,
  preparePullRequestRun,
  preparePublicationRun as prepareRun,
  publishedCommands,
  setUpPublication,
  writeRunFile,
} from '../fixtures/publicationRun.js';

const setUp = () => setUpPublication(onTestFinished);

it('publishes a new pull request with the approved title, body, base, head, and draft', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const dryRun = await run(dryRunPullRequest(directory));

  expect(fake.calls).toEqual([]);
  expect(dryRun).toMatchObject({ findings: [] });

  const published = await run({
    ...dryRunPullRequest(directory),
    action: 'publish',
    token: dryRun.token,
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
        expect.stringMatching(/tau-publish-[^/]+\/\d+-body\.md$/u),
        '--draft',
      ],
      contents: Buffer.from('Adds it.\n'),
    },
  ]);

  expect(published.url).toBe('https://github.com/sQVe/tau/pull/8');
  expect(publishedCommands(fake)).toEqual(['pr create']);
});

it('publishes an edited pull request with the approved title and body', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const request = dryRunPullRequestEdit(directory);

  const dryRun = await run(request);

  const published = await run({ ...request, action: 'publish', token: dryRun.token });

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
        expect.stringMatching(/tau-publish-[^/]+\/\d+-body\.md$/u),
      ],
      contents: Buffer.from('Adds it.\n'),
    },
  ]);

  expect(published.url).toBeNull();
  expect(publishedCommands(fake)).toEqual(['pr edit']);
});

it('creates a pull request without --draft when draft is false', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');

  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = { ...dryRunPullRequest(directory), draft: false };
  const dryRun = await run(request);

  await run({ ...request, action: 'publish', token: dryRun.token });

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
    expect.stringMatching(/tau-publish-[^/]+\/\d+-body\.md$/u),
  ]);
});

it('returns the em dash finding from the dry run and publishes with it', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run, { body: 'Adds it \u2014 now.\n' });

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);

  expect(dryRun['findings']).toEqual([
    { file: 'body.md', rule: 'emDash', line: 1, excerpt: 'Adds it \u2014 now.' },
  ]);

  await run({ ...request, action: 'publish', token: dryRun.token });

  expect(fake.writes).toHaveLength(1);
  expect(fake.writes[0]?.contents).toEqual(Buffer.from('Adds it \u2014 now.\n'));

  expect(fake.writes[0]?.commandArguments.join(' ')).toMatch(/tau-publish-[^/]+\/\d+-body\.md/u);
});

it.each(['--body-file', '--input'])(
  'publishes a title equal to %s and still rewrites the real file argument',
  async (flag) => {
    const { fake, run } = await setUp();
    const directory = await preparePullRequestRun(run);
    await writeRunFile(directory, 'title.md', `${flag}\n`);

    const request = dryRunPullRequest(directory);
    const dryRun = await run(request);

    await run({ ...request, action: 'publish', token: dryRun.token });

    const commandArguments = fake.writes[0]?.commandArguments ?? [];

    expect(fake.writes[0]?.contents).toEqual(Buffer.from('Adds it.\n'));
    expect(commandArguments[commandArguments.indexOf('--title') + 1]).toBe(flag);

    expect(commandArguments.join(' ')).toMatch(/--body-file \/.*tau-publish-[^/]+\/\d+-body\.md/u);
  },
);
