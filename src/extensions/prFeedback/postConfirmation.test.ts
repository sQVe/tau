import { copyFile, cp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../tests/toolContext.js';
import type { FakeThread, GhFake } from './fixtures/ghFake.js';
import {
  botThread,
  mixedReplies,
  person,
  personThread,
  postFailure,
  readPosted,
  recordedReply,
  recordedResolve,
  recordingConfirm,
  replyTo,
  setUp,
  snapshotRound,
  thread,
  writeReplies,
} from './fixtures/postRound.js';

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
    const outside = temporaryDirectory(onTestFinished, 'tau-pr-feedback-outside-');

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

    const failure = await postFailure(post(details, context));

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/read again/u);
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
        recordedReply('thread-bot', 'Added.', 900),
        recordedResolve('thread-bot'),
        recordedReply('thread-person', 'Renamed.', 901),
      ],
    };

    const { context } = recordingConfirm(root, true, () =>
      writeFile(join(details.directory, 'posted.json'), JSON.stringify(otherSession)),
    );

    const failure = await postFailure(post(details, context));

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/read again/u);
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

  it('posts nothing when the head moves while the final check rereads mergeable', async () => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: null,
    });

    fake.nextHeads = ['abc123', 'abc123', 'abc123', 'def456'];
    fake.nextMergeable = ['UNKNOWN', 'MERGEABLE', 'UNKNOWN', 'MERGEABLE'];

    await expect(post(details)).rejects.toThrow(
      /headRefOid changed from abc123 to def456.*Read again/u,
    );

    expect(fake.writes).toEqual([]);
    expect(await readPosted(details.directory)).toBeUndefined();
  });

  it('posts nothing when the pull request closes while the final check rereads mergeable', async () => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: null,
    });

    fake.nextStates = ['OPEN', 'OPEN', 'OPEN', 'CLOSED'];
    fake.nextMergeable = ['UNKNOWN', 'MERGEABLE', 'UNKNOWN', 'MERGEABLE'];

    await expect(post(details)).rejects.toThrow('is CLOSED, not OPEN.');
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
    vi.stubEnv('TAU_ROLE', 'worker');
    vi.stubEnv('TAU_WORKER_RECORD', undefined);

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

    const rounds = join(root, '.tau', 'pr-feedback');

    for (const directory of [root, join(root, '.tau'), rounds, join(details.directory, 'nested')]) {
      await expect(post(details, noUiContext(root), { directory })).rejects.toThrow(
        'The feedback directory must',
      );
    }

    expect(fake.writes).toEqual([]);
  });
});

describe('post', () => {
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

  it('quotes the comment a reply answers when the thread has several comments', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [
      thread({
        id: 'thread-person',
        comments: [
          { id: 101, author: person, body: 'First remark.' },
          { id: 102, author: { login: 'other', bot: false }, body: 'Later remark.' },
        ],
      }),
    ];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-person', 'Done.', false)],
      comment: null,
    });

    const { context, prompts } = recordingConfirm(root, false);

    await post(details, context);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.message).toContain('@reviewer');
    expect(prompts[0]?.message).toContain('First remark.');
    expect(prompts[0]?.message).not.toContain('Later remark.');
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
});
