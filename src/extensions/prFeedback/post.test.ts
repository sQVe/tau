import {
  chmod,
  copyFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
import { isMissingFile } from '../../errors.js';
import { createGhFake } from './fixtures/ghFake.js';
import type { FakeThread, GhFake } from './fixtures/ghFake.js';
import { createPrFeedbackTool } from './tool.js';
import type { PrFeedbackInput } from './tool.js';

interface ReadDetails {
  directory: string;
  stateToken: string;
  pr: { headRefOid: string };
}

// Lets a test act as another session right after post reads posted.json.
const postedHooks = vi.hoisted(() => ({
  afterRead: undefined as (() => Promise<void>) | undefined,
}));

vi.mock(import('./replies.js'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    readPosted: async (directory: string) => {
      const posted = await original.readPosted(directory);
      const afterRead = postedHooks.afterRead;

      postedHooks.afterRead = undefined;
      await afterRead?.();

      return posted;
    },
  };
});

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

const snapshotRound = async (directory: string) => {
  const names = await readdir(directory);

  return Promise.all(
    names.toSorted().map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
  );
};

const readPosted = (directory: string) =>
  readFile(join(directory, 'posted.json'), 'utf8').then(
    (text) => JSON.parse(text) as unknown,
    (error: unknown) => {
      if (isMissingFile(error)) {
        return undefined;
      }

      throw error;
    },
  );

const personThread = () =>
  thread({ id: 'thread-person', comments: [{ id: 101, author: person, body: 'Rename this.' }] });

const botThread = () =>
  thread({ id: 'thread-bot', comments: [{ id: 201, author: bot, body: 'Add a test.' }] });

const replyTo = (id: string, reply: string | null, resolve = true) => ({ id, reply, resolve });

const recordingConfirm = (root: string, answer: boolean, during?: () => void | Promise<void>) => {
  const prompts: { title: string; message: string }[] = [];

  const context = confirmContext(root, async (title, message) => {
    prompts.push({ title, message });
    await during?.();

    return answer;
  });

  return { context, prompts };
};

const mixedReplies = {
  version: 1,
  threads: [replyTo('thread-bot', 'Added.'), replyTo('thread-person', 'Renamed.', false)],
  comment: null,
};

const recordedWrite = (
  kind: string,
  threadId: string,
  text: string | null,
  commentId: number | null,
) => ({
  kind,
  thread: threadId,
  url: `https://github.com/sQVe/tau/pull/7#discussion_r${threadId === 'thread-bot' ? 201 : 101}`,
  text,
  state: 'posted',
  commentId,
  earlierCommentIds: [],
});

const postFailure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as Error,
  );

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

  it('posts nothing when the feedback directory becomes a symlink during the confirm', async () => {
    const { root, fake, read, post } = await setUp();
    const outside = await mkdtemp(join(tmpdir(), 'tau-pr-feedback-outside-'));

    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    fake.threads = [botThread(), personThread()];

    const details = await read();

    await writeReplies(details.directory, mixedReplies);

    const { context } = recordingConfirm(root, true, async () => {
      await cp(details.directory, outside, { recursive: true });
      await rm(details.directory, { recursive: true });
      await symlink(outside, details.directory);
    });

    await expect(post(details, context)).rejects.toThrow(/symlink/u);
    expect(fake.writes).toEqual([]);
    expect(await readPosted(outside)).toBeUndefined();
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

  it('posts nothing when another session posts the round during the confirm', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread(), personThread()];

    const details = await read();

    await writeReplies(details.directory, mixedReplies);

    const otherSession = {
      version: 2,
      writes: [
        recordedWrite('reply', 'thread-bot', 'Added.', 900),
        recordedWrite('resolve', 'thread-bot', null, null),
        recordedWrite('reply', 'thread-person', 'Renamed.', 901),
      ],
    };

    const { context } = recordingConfirm(root, true, () =>
      writeFile(join(details.directory, 'posted.json'), JSON.stringify(otherSession)),
    );

    await expect(post(details, context)).rejects.toThrow(/read again/u);
    expect(fake.writes).toEqual([]);
    expect(await readPosted(details.directory)).toEqual(otherSession);
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

    const before = await snapshotRound(details.directory);

    await expect(post(details)).rejects.toThrow(
      /needs the user's confirmation.*session without UI cannot give.*Nothing was written/u,
    );

    expect(fake.writes).toEqual([]);
    expect(await snapshotRound(details.directory)).toEqual(before);
  });

  it('posts nothing and asks nothing in a worker with UI', async () => {
    vi.stubEnv('TAU_WORKER_RECORD', '/records/task-one');

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread(), personThread()];

    const details = await read();

    await writeReplies(details.directory, mixedReplies);

    const before = await snapshotRound(details.directory);
    const confirm = recordingConfirm(root, true);

    await expect(post(details, confirm.context)).rejects.toThrow(
      /needs the user's confirmation.*worker cannot give.*Nothing was written/u,
    );

    expect(confirm.prompts).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(await snapshotRound(details.directory)).toEqual(before);
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
      version: 2,
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

    expect(prompts).toEqual([
      {
        title: 'Post 1 reply to people on PR #7?',
        message: '1. @reviewer on src/tau.ts:12\n   > Rename this.\n   Renamed.',
      },
    ]);

    expect(fake.writes).toEqual([
      { kind: 'reply', replyTo: 201, body: 'Added.' },
      { kind: 'resolve', threadId: 'thread-bot' },
      { kind: 'reply', replyTo: 101, body: 'Renamed.' },
    ]);

    expect(result).toMatchObject({ status: 'posted' });
  });

  it('names the author, place, and answered comment of each person write in the confirm', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [
      thread({
        id: 'thread-person',
        line: null,
        comments: [{ id: 101, author: person, body: `Rename this.\n\n${'Why? '.repeat(20)}` }],
      }),
      thread({
        id: 'thread-ghost',
        comments: [{ id: 102, author: null, body: 'Add a test.' }],
      }),
    ];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [
        replyTo('thread-person', 'Renamed.\n\nIt reads better.'),
        replyTo('thread-ghost', null),
      ],
      comment: { body: 'Thanks.', answers: [] },
    });

    const { context, prompts } = recordingConfirm(root, false);

    await post(details, context);

    expect(prompts).toEqual([
      {
        title: 'Post 2 replies to people and resolve 2 threads on PR #7?',
        message: [
          '1. @reviewer on src/tau.ts',
          `   > Rename this. ${'Why? '.repeat(11)}W...`,
          '   Renamed.',
          '',
          '   It reads better.',
          '',
          '2. Resolve the thread of @reviewer on src/tau.ts',
          `   > Rename this. ${'Why? '.repeat(11)}W...`,
          '',
          '3. Resolve the thread of A deleted user on src/tau.ts:12',
          '   > Add a test.',
          '',
          '4. Comment on PR #7',
          '   Thanks.',
        ].join('\n'),
      },
    ]);
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

    const failure = await postFailure(post(details, recordingConfirm(root, true).context));

    expect(failure?.message).toContain('HTTP 502');

    expect(failure?.message).toContain(
      `\nPosted:\n- Reply to https://github.com/sQVe/tau/pull/7#discussion_r101:\nRenamed.\nNot posted:\n- Resolve https://github.com/sQVe/tau/pull/7#discussion_r201\n- Comment on https://github.com/sQVe/tau/pull/7:\nThanks.\n${details.directory}/posted.json`,
    );

    expect(await readPosted(details.directory)).toMatchObject({
      writes: [
        { kind: 'reply', thread: 'thread-person', state: 'posted', commentId: 1000 },
        { kind: 'resolve', thread: 'thread-person', state: 'uncertain' },
      ],
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

describe('post save failure', () => {
  it('names the write that posted.json could not record', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [personThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-person', 'Renamed.')],
      comment: null,
    });

    // A read-only round directory makes every save of posted.json fail, and reads still work.
    const { context } = recordingConfirm(root, true, async () => {
      await chmod(details.directory, 0o500);
      onTestFinished(() => chmod(details.directory, 0o700));
    });

    const failure = await postFailure(post(details, context));

    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 101, body: 'Renamed.' }]);

    expect(failure?.message).toContain(
      'Reply to https://github.com/sQVe/tau/pull/7#discussion_r101:\nRenamed.\nAdd it to posted.json before a retry',
    );

    expect(failure?.message).not.toContain('posted.json records the posted writes');

    expect(failure?.message).toContain(
      '\nPosted:\n- Reply to https://github.com/sQVe/tau/pull/7#discussion_r101:\nRenamed.\nNot posted:\n- Resolve https://github.com/sQVe/tau/pull/7#discussion_r101\nposted.json',
    );
  });
});

describe('post uncertain save failure', () => {
  it('names the uncertain write that posted.json could not record', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [personThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-person', 'Renamed.')],
      comment: null,
    });

    fake.loseWriteResponse(1);

    const { context } = recordingConfirm(root, true, async () => {
      await chmod(details.directory, 0o500);
      onTestFinished(() => chmod(details.directory, 0o700));
    });

    const failure = await postFailure(post(details, context));

    expect(failure?.message).toContain(
      'Reply to https://github.com/sQVe/tau/pull/7#discussion_r101:\nRenamed.\nCheck the pull request for it before a retry',
    );

    expect(failure?.message).toContain('its outcome is uncertain');

    expect(failure?.message).toContain(
      '\nPosted:\n- none\nNot posted:\n- Resolve https://github.com/sQVe/tau/pull/7#discussion_r101\nposted.json',
    );

    expect(await readPosted(details.directory)).toBeUndefined();
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

  const writeDescriptions = [
    '- Reply to https://github.com/sQVe/tau/pull/7#discussion_r201:\nAdded.',
    '- Resolve https://github.com/sQVe/tau/pull/7#discussion_r201',
    '- Comment on https://github.com/sQVe/tau/pull/7:\nDone.',
  ];

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

      const failure = await postFailure(post(details));
      const saved = (await readPosted(details.directory)) as { version: number; writes: unknown[] };
      const posted = writeDescriptions.slice(0, index + 1).join('\n');
      const notPosted = writeDescriptions.slice(index + 1).join('\n') || '- none';

      expect(failure?.message).toContain(problem);
      expect(saved.writes).toHaveLength(index + 1);
      expect(saved.writes.at(-1)).toMatchObject({ kind: writeKinds[index], commentId: null });

      expect(failure?.message).toContain(
        `\nNot posted:\n${notPosted}\n${details.directory}/posted.json`,
      );

      expect(fake.writes).toHaveLength(index + 1);

      expect(saved.version).toBe(2);

      expect(failure?.message).toContain(`\nPosted:\n${posted}\nNot posted:`);
    },
  );

  it.each(kinds)('records a failed $key command as uncertain', async ({ key, index }) => {
    const { fake, details, post } = await writeFixture();

    fake.failCommand(key);

    const failure = await postFailure(post(details));

    expect(failure?.message).toContain('HTTP 502');
    const posted = writeDescriptions.slice(0, index).join('\n') || '- none';
    const notPosted = writeDescriptions.slice(index + 1).join('\n') || '- none';

    expect(failure?.message).toContain(
      `\nUncertain:\n${writeDescriptions[index]}\nPosted:\n${posted}\nNot posted:\n${notPosted}\n${details.directory}/posted.json`,
    );

    expect(fake.writes).toHaveLength(index);
  });
});

describe('post uncertain writes', () => {
  const writeFixture = async () => {
    const context = await setUp();

    context.fake.threads = [botThread()];
    context.fake.comments = [{ id: 302, author: bot, body: 'Summary.' }];

    const details = await context.read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.', false)],
      comment: { body: 'Done.', answers: ['302'] },
    });

    return { ...context, details };
  };

  const kinds = [
    { kind: 'reply', attempt: 1, write: { kind: 'reply', replyTo: 201, body: 'Added.' } },
    { kind: 'comment', attempt: 2, write: { kind: 'comment', body: 'Done.' } },
  ];

  it.each(kinds)(
    'saves a $kind as uncertain when gh is killed after GitHub took it',
    async ({ kind, attempt }) => {
      const { fake, details, post } = await writeFixture();

      fake.loseWriteResponse(attempt);

      const failure = await postFailure(post(details));

      expect(failure?.message).toMatch(/outcome is uncertain.*A retry checks GitHub/su);
      const saved = (await readPosted(details.directory)) as { writes: { state: string }[] };
      const posted = saved.writes.filter((write) => write.state === 'posted');
      const reply = '- Reply to https://github.com/sQVe/tau/pull/7#discussion_r201:\nAdded.';
      const comment = '- Comment on https://github.com/sQVe/tau/pull/7:\nDone.';
      const uncertain = kind === 'reply' ? reply : comment;
      const postedList = kind === 'reply' ? '- none' : reply;
      const notPosted = kind === 'reply' ? comment : '- none';

      expect(posted).toHaveLength(attempt - 1);

      expect(failure?.message).toContain(
        `\nUncertain:\n${uncertain}\nPosted:\n${postedList}\nNot posted:\n${notPosted}\n${details.directory}/posted.json`,
      );

      expect(await readPosted(details.directory)).toMatchObject({
        version: 2,
        writes: [
          ...posted,
          {
            kind,
            text: kind === 'reply' ? 'Added.' : 'Done.',
            state: 'uncertain',
            commentId: null,
            earlierCommentIds: kind === 'reply' ? [201] : [302],
          },
        ],
      });
    },
  );

  it.each(kinds)(
    'settles an uncertain $kind that GitHub has without posting it again',
    async ({ kind, attempt, write }) => {
      const { fake, details, post } = await writeFixture();

      fake.loseWriteResponse(attempt);
      await postFailure(post(details));

      const retry = await post(details);

      expect(fake.writes.filter((made) => made.kind === kind)).toEqual([write]);
      expect(fake.writes).toHaveLength(2);
      expect(retry).toMatchObject({ status: kind === 'reply' ? 'posted' : 'unchanged' });

      expect(await readPosted(details.directory)).toMatchObject({
        writes: expect.arrayContaining([
          expect.objectContaining({ kind, state: 'posted', commentId: 999 + attempt }),
        ]) as unknown,
      });
    },
  );

  it.each(kinds)(
    'posts an uncertain $kind once when GitHub does not have it',
    async ({ kind, attempt, write }) => {
      const { fake, details, post } = await writeFixture();

      fake.failWrite(attempt);
      await postFailure(post(details));

      expect(fake.writes.filter((made) => made.kind === kind)).toEqual([]);

      await post(details);

      expect(fake.writes.filter((made) => made.kind === kind)).toEqual([write]);
      expect(fake.writes).toHaveLength(2);
    },
  );

  it.each([
    {
      outcome: 'took',
      lose: (fake: GhFake) => {
        fake.loseWriteResponse(1);
      },
      retried: false,
    },
    {
      outcome: 'did not take',
      lose: (fake: GhFake) => {
        fake.failWrite(1);
      },
      retried: true,
    },
  ])('settles an uncertain resolve that GitHub $outcome', async ({ lose, retried }) => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', null)],
      comment: null,
    });

    lose(fake);
    await postFailure(post(details));

    const retry = await post(details);

    expect(fake.writes).toEqual([{ kind: 'resolve', threadId: 'thread-bot' }]);
    expect(retry).toMatchObject({ status: retried ? 'posted' : 'unchanged' });

    expect(await readPosted(details.directory)).toMatchObject({
      writes: [{ kind: 'resolve', state: 'posted' }],
    });
  });
});

describe('post settled writes', () => {
  it('posts an uncertain reply again when only an earlier comment has its text', async () => {
    const { root, fake, read, post } = await setUp();
    const target = botThread();

    target.comments.push({ id: 150, author: { login: 'sqve', bot: false }, body: 'Added.' });
    fake.threads = [target];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.', false)],
      comment: null,
    });

    fake.failWrite(1);
    await postFailure(post(details, recordingConfirm(root, true).context));

    const retry = await post(details, recordingConfirm(root, true).context);

    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 201, body: 'Added.' }]);
    expect(retry).toMatchObject({ status: 'posted', posted: [{ kind: 'reply', commentId: 1000 }] });
  });

  it('keeps the writes another session saves while post settles', async () => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread()];
    fake.comments = [{ id: 302, author: bot, body: 'Summary.' }];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.', false)],
      comment: { body: 'Done.', answers: ['302'] },
    });

    fake.loseWriteResponse(2);
    await postFailure(post(details));

    const otherSession = recordedWrite('resolve', 'thread-bot', null, null);

    postedHooks.afterRead = async () => {
      const saved = JSON.parse(await readFile(join(details.directory, 'posted.json'), 'utf8')) as {
        writes: unknown[];
      };

      await writeFile(
        join(details.directory, 'posted.json'),
        JSON.stringify({ version: 2, writes: [...saved.writes, otherSession] }),
      );
    };

    const retry = await post(details);

    expect(retry).toMatchObject({ status: 'unchanged' });
    expect(fake.writes).toHaveLength(2);

    expect(await readPosted(details.directory)).toMatchObject({
      writes: [
        { kind: 'reply', state: 'posted', commentId: 1000 },
        { kind: 'comment', state: 'posted', commentId: 1001 },
        otherSession,
      ],
    });
  });

  it('keeps an uncertain write another session saves while post settles', async () => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.', false)],
      comment: null,
    });

    fake.loseWriteResponse(1);
    await postFailure(post(details));

    const otherSession = {
      ...recordedWrite('reply', 'thread-bot', 'Also added.', null),
      state: 'uncertain',
      earlierCommentIds: [201, 1000],
    };

    postedHooks.afterRead = async () => {
      const saved = JSON.parse(await readFile(join(details.directory, 'posted.json'), 'utf8')) as {
        writes: unknown[];
      };

      await writeFile(
        join(details.directory, 'posted.json'),
        JSON.stringify({ version: 2, writes: [...saved.writes, otherSession] }),
      );
    };

    const retry = await post(details);

    expect(retry).toMatchObject({ status: 'unchanged' });
    expect(fake.writes).toHaveLength(1);

    expect(await readPosted(details.directory)).toMatchObject({
      writes: [{ kind: 'reply', state: 'posted', commentId: 1000 }, otherSession],
    });
  });
});
