import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
import { createGhFake } from './fixtures/ghFake.js';
import type { FakeThread, GhFake } from './fixtures/ghFake.js';
import { createPrFeedbackTool } from './tool.js';
import type { PrFeedbackInput } from './tool.js';

interface ReadDetails {
  directory: string;
  stateToken: string;
  pr: { headRefOid: string };
}

const person = { login: 'reviewer', bot: false };
const bot = { login: 'coderabbitai', bot: true };

const thread = (overrides: Partial<FakeThread> & { id: string }): FakeThread => ({
  path: 'src/tau.ts',
  line: 12,
  isResolved: false,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  hasMoreComments: false,
  comments: [{ id: 101, author: person, body: 'Rename this.' }],
  ...overrides,
});

const setUp = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createGhFake();
  const tool = createPrFeedbackTool(fake.exec);

  const run = async (input: PrFeedbackInput, context: ExtensionToolContext) => {
    const result = await tool.execute('call', input, undefined, undefined, context);

    return result.details;
  };

  const read = async () =>
    (await run(
      { action: 'read', repository: 'github.com/sQVe/tau', pr: 7 },
      noUiContext(root),
    )) as unknown as ReadDetails;

  const post = (
    details: ReadDetails,
    context: ExtensionToolContext = noUiContext(root),
    input: Partial<PrFeedbackInput> = {},
  ) =>
    run(
      {
        action: 'post',
        directory: details.directory,
        stateToken: details.stateToken,
        head: details.pr.headRefOid,
        ...input,
      },
      context,
    );

  return { root, fake, read, post };
};

const writeReplies = (directory: string, replies: unknown) =>
  writeFile(join(directory, 'replies.json'), JSON.stringify(replies));

const readPosted = (directory: string) =>
  readFile(join(directory, 'posted.json'), 'utf8').then(
    (text) => JSON.parse(text) as unknown,
    () => undefined,
  );

const personThread = () =>
  thread({ id: 'thread-person', comments: [{ id: 101, author: person, body: 'Rename this.' }] });

const botThread = () =>
  thread({ id: 'thread-bot', comments: [{ id: 201, author: bot, body: 'Add a test.' }] });

const replyTo = (id: string, reply: string | null, resolve = true) => ({ id, reply, resolve });

const recordingConfirm = (root: string, answer: boolean, during?: () => void) => {
  const prompts: { title: string; message: string }[] = [];

  const context = confirmContext(root, async (title, message) => {
    prompts.push({ title, message });
    during?.();

    return answer;
  });

  return { context, prompts };
};

const mixedReplies = {
  version: 1,
  threads: [replyTo('thread-bot', 'Added.'), replyTo('thread-person', 'Renamed.', false)],
  comment: null,
};

describe('post refusals', () => {
  it.each([
    {
      change: 'added',
      arrange: (fake: GhFake) => {
        fake.threads[0]?.comments.push({ id: 102, author: person, body: 'Also this.' });
      },
    },
    {
      change: 'edited',
      arrange: (fake: GhFake) => {
        fake.comments[0] = { id: 301, author: person, body: 'Can this land tomorrow?' };
      },
    },
    {
      change: 'deleted',
      arrange: (fake: GhFake) => {
        fake.comments = [];
      },
    },
  ])('posts nothing when a person $change a comment since the read', async ({ arrange }) => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [personThread()];
    fake.comments = [{ id: 301, author: person, body: 'Can this land today?' }];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-person', 'Renamed.')],
      comment: null,
    });

    arrange(fake);

    await expect(post(details, recordingConfirm(root, true).context)).rejects.toThrow(
      /read again/u,
    );

    expect(fake.writes).toEqual([]);
    expect(await readPosted(details.directory)).toBeUndefined();
  });

  it('posts nothing when a person comments while the user answers the confirm', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread(), personThread()];

    const details = await read();

    await writeReplies(details.directory, mixedReplies);

    const { context } = recordingConfirm(root, true, () => {
      fake.comments.push({ id: 303, author: person, body: 'Wait.' });
    });

    await expect(post(details, context)).rejects.toThrow(/read again/u);
    expect(fake.writes).toEqual([]);
  });

  it.each([
    {
      change: 'resolves a target thread',
      arrange: (target: FakeThread) => {
        target.isResolved = true;
      },
    },
    {
      change: 'blocks replies to a target thread',
      arrange: (target: FakeThread) => {
        target.viewerCanReply = false;
      },
    },
  ])('posts nothing when GitHub $change during the confirm', async ({ arrange }) => {
    const { root, fake, read, post } = await setUp();
    const target = personThread();

    fake.threads = [botThread(), target];

    const details = await read();

    await writeReplies(details.directory, mixedReplies);

    const { context } = recordingConfirm(root, true, () => {
      arrange(target);
    });

    await expect(post(details, context)).rejects.toThrow(/read again/u);
    expect(fake.writes).toEqual([]);
    expect(await readPosted(details.directory)).toBeUndefined();
  });

  it('posts nothing when pull-request.json names another pull request', async () => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: null,
    });

    await writeFile(
      join(details.directory, 'pull-request.json'),
      JSON.stringify({ version: 1, repository: 'github.com/sQVe/tau', pr: 8 }),
    );

    await expect(post(details)).rejects.toThrow(/read again/u);
    expect(fake.writes).toEqual([]);
    expect(await readPosted(details.directory)).toBeUndefined();
  });

  it('posts nothing when the head moved', async () => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: null,
    });

    if (fake.pullRequest !== undefined) {
      fake.pullRequest.headRefOid = 'def456';
    }

    await expect(post(details)).rejects.toThrow('The pull request head is def456, not abc123.');
    expect(fake.writes).toEqual([]);
    expect(await readPosted(details.directory)).toBeUndefined();
  });

  it('posts nothing, bot writes included, without a UI to confirm a person write', async () => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread(), personThread()];

    const details = await read();

    await writeReplies(details.directory, mixedReplies);

    await expect(post(details)).rejects.toThrow(/needs a session with UI to confirm/u);
    expect(fake.writes).toEqual([]);
    expect(await readPosted(details.directory)).toBeUndefined();
  });

  it.each([
    { fixture: 'malformed.json', error: /^Malformed .*replies\.json/u },
    { fixture: 'newer.json', error: /replies\.json has a newer format/u },
  ])('posts nothing from a $fixture reply file', async ({ fixture, error }) => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [personThread(), botThread()];

    const details = await read();

    await copyFile(
      join(import.meta.dirname, 'fixtures', 'replies', fixture),
      join(details.directory, 'replies.json'),
    );

    await expect(post(details, recordingConfirm(root, true).context)).rejects.toThrow(error);
    expect(fake.writes).toEqual([]);
  });

  it('refuses a directory read did not return', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: null,
    });

    for (const directory of [root, join(root, '.tau'), join(details.directory, 'nested')]) {
      await expect(post(details, noUiContext(root), { directory })).rejects.toThrow(
        'The directory must be .tau/pr-feedback/<name>',
      );
    }

    expect(fake.writes).toEqual([]);
  });
});

describe('post', () => {
  it('posts writes to bots without asking and records them', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread()];
    fake.reviews = [{ id: 401, author: bot, state: 'COMMENTED', body: 'Summary.' }];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: { body: 'Addressed the summary.', answers: ['401'] },
    });

    const { context, prompts } = recordingConfirm(root, false);
    const result = await post(details, context);

    expect(prompts).toEqual([]);

    expect(fake.writes).toEqual([
      { kind: 'reply', replyTo: 201, body: 'Added.' },
      { kind: 'resolve', threadId: 'thread-bot' },
      { kind: 'comment', body: 'Addressed the summary.' },
    ]);

    expect(result).toMatchObject({
      status: 'posted',
      posted: [
        { kind: 'reply', thread: 'thread-bot', text: 'Added.', commentId: 1000 },
        { kind: 'resolve', thread: 'thread-bot', text: null, commentId: null },
        { kind: 'comment', thread: null, text: 'Addressed the summary.', commentId: 1001 },
      ],
      skipped: [],
    });

    expect(await readPosted(details.directory)).toEqual({
      version: 1,
      writes: (result as { posted: unknown[] }).posted,
    });
  });

  it('passes --hostname and the pull request to every write', async () => {
    const { root, fake } = await setUp();
    const tool = createPrFeedbackTool(fake.exec);

    fake.threads = [botThread()];

    const readResult = await tool.execute(
      'call',
      { action: 'read', repository: 'ghe.example.com/sQVe/tau', pr: 7 },
      undefined,
      undefined,
      noUiContext(root),
    );

    const details = readResult.details as unknown as ReadDetails;

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: { body: 'Done.', answers: [] },
    });

    await tool.execute(
      'call',
      {
        action: 'post',
        directory: details.directory,
        stateToken: details.stateToken,
        head: details.pr.headRefOid,
      },
      undefined,
      undefined,
      recordingConfirm(root, true).context,
    );

    const writeCalls = fake.calls.slice(-3).map((call) => call.commandArguments);

    expect(writeCalls).toEqual([
      [
        'api',
        '--hostname',
        'ghe.example.com',
        '-X',
        'POST',
        'repos/sQVe/tau/pulls/7/comments/201/replies',
        '-f',
        'body=Added.',
      ],
      [
        'api',
        'graphql',
        '--hostname',
        'ghe.example.com',
        '-f',
        'query=mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }',
        '-F',
        'id=thread-bot',
      ],
      [
        'api',
        '--hostname',
        'ghe.example.com',
        '-X',
        'POST',
        'repos/sQVe/tau/issues/7/comments',
        '-f',
        'body=Done.',
      ],
    ]);
  });

  it('asks once before a person write, listing each person write in full', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread(), personThread()];

    const details = await read();

    await writeReplies(details.directory, mixedReplies);

    const { context, prompts } = recordingConfirm(root, true);
    const result = await post(details, context);

    expect(prompts).toHaveLength(1);

    expect(prompts[0]?.message).toContain(
      'Reply to https://github.com/sQVe/tau/pull/7#discussion_r101:\nRenamed.',
    );

    expect(prompts[0]?.message).not.toContain('discussion_r201');

    expect(fake.writes).toEqual([
      { kind: 'reply', replyTo: 201, body: 'Added.' },
      { kind: 'resolve', threadId: 'thread-bot' },
      { kind: 'reply', replyTo: 101, body: 'Renamed.' },
    ]);

    expect(result).toMatchObject({ status: 'posted' });
  });

  it('posts nothing, bot writes included, when the user declines', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread(), personThread()];

    const details = await read();

    await writeReplies(details.directory, mixedReplies);

    const result = await post(details, recordingConfirm(root, false).context);

    expect(result).toEqual({ status: 'declined', posted: [], skipped: [] });
    expect(fake.writes).toEqual([]);
    expect(await readPosted(details.directory)).toBeUndefined();
  });

  it('retries a failed post with only the missing writes', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [personThread(), botThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-person', 'Renamed.'), replyTo('thread-bot', null)],
      comment: { body: 'Thanks.', answers: [] },
    });

    fake.failWrite(2);

    const failure = await post(details, recordingConfirm(root, true).context).then(
      () => undefined,
      (error: unknown) => error as { message: string; posted: unknown[]; notPosted: unknown[] },
    );

    expect(failure?.message).toContain('HTTP 502');
    expect(failure?.posted).toMatchObject([{ kind: 'reply', thread: 'thread-person' }]);

    expect(failure?.notPosted).toMatchObject([
      { kind: 'resolve', thread: 'thread-person' },
      { kind: 'resolve', thread: 'thread-bot' },
      { kind: 'comment', thread: null, text: 'Thanks.' },
    ]);

    expect(await readPosted(details.directory)).toMatchObject({
      writes: [{ kind: 'reply', thread: 'thread-person', commentId: 1000 }],
    });

    const retry = await post(details, recordingConfirm(root, true).context);

    expect(fake.writes).toEqual([
      { kind: 'reply', replyTo: 101, body: 'Renamed.' },
      { kind: 'resolve', threadId: 'thread-person' },
      { kind: 'resolve', threadId: 'thread-bot' },
      { kind: 'comment', body: 'Thanks.' },
    ]);

    expect(retry).toMatchObject({
      status: 'posted',
      posted: [
        { kind: 'resolve', thread: 'thread-person' },
        { kind: 'resolve', thread: 'thread-bot' },
        { kind: 'comment' },
      ],
      skipped: [{ kind: 'reply', thread: 'thread-person' }],
    });

    const again = await post(details, recordingConfirm(root, true).context);

    expect(again).toMatchObject({ status: 'unchanged', posted: [] });
    expect(fake.writes).toHaveLength(4);
  });
});

describe('post write output', () => {
  const writeFixture = async () => {
    const context = await setUp();

    context.fake.threads = [botThread()];
    context.fake.comments = [{ id: 302, author: bot, body: 'Summary.' }];

    const details = await context.read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: { body: 'Done.', answers: ['302'] },
    });

    return { ...context, details };
  };

  const kinds = [
    { key: 'reply' as const, index: 0, missing: '{"html_url": "u"}' },
    { key: 'resolve' as const, index: 1, missing: '{"data": {}}' },
    { key: 'issue comment' as const, index: 2, missing: '{}' },
  ];

  const writeKinds = ['reply', 'resolve', 'comment'];

  it.each(
    kinds.flatMap((kind) => [
      { ...kind, output: 'Bad credentials', problem: 'printed output that is not JSON' },
      { ...kind, output: '', problem: 'printed output that is not JSON' },
      { ...kind, output: kind.missing, problem: 'printed unexpected output' },
    ]),
  )(
    'records a $key whose output gh printed as "$output" as posted, then stops',
    async ({ key, index, output, problem }) => {
      const { fake, details, post } = await writeFixture();

      fake.overrideOutput(key, output);

      const failure = await post(details).then(
        () => undefined,
        (error: unknown) => error as { message: string; posted: unknown[]; notPosted: unknown[] },
      );

      expect(failure?.message).toContain(problem);
      expect(failure?.posted).toHaveLength(index + 1);
      expect(failure?.posted.at(-1)).toMatchObject({ kind: writeKinds[index], commentId: null });
      expect(failure?.notPosted).toHaveLength(2 - index);
      expect(fake.writes).toHaveLength(index + 1);

      expect(await readPosted(details.directory)).toEqual({
        version: 1,
        writes: failure?.posted,
      });
    },
  );

  it.each(kinds)('records nothing for a failed $key command', async ({ key, index }) => {
    const { fake, details, post } = await writeFixture();

    fake.failCommand(key);

    const failure = await post(details).then(
      () => undefined,
      (error: unknown) => error as { message: string; posted: unknown[]; notPosted: unknown[] },
    );

    expect(failure?.message).toContain('HTTP 502');
    expect(failure?.posted).toHaveLength(index);
    expect(failure?.notPosted).toHaveLength(3 - index);
    expect(fake.writes).toHaveLength(index);
  });
});
