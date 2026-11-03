import { describe, expect, it } from 'vitest';

import { confirmContext } from '../../../tests/toolContext.js';
import type { GhFake } from './fixtures/ghFake.js';
import {
  bot,
  botThread,
  postFailure,
  readPosted,
  recordedReply,
  recordingConfirm,
  replyTo,
  setUp,
  thread,
  writeReplies,
} from './fixtures/postRound.js';

const uncertainWriteFixture = async () => {
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

describe('post uncertain writes', () => {
  const writeFixture = uncertainWriteFixture;

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

      const expectedWrites = [
        { kind: 'reply', replyTo: 201, body: 'Added.' },
        { kind: 'comment', body: 'Done.' },
      ];

      const expectedPosted = [recordedReply('thread-bot', 'Added.', 1000)];

      expect(posted).toHaveLength(attempt - 1);

      expect(posted).toEqual(expectedPosted.slice(0, attempt - 1));
      expect(fake.writes).toEqual(expectedWrites.slice(0, attempt));

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

describe('post uncertain resolve of a viewer-started thread', () => {
  it('posts the resolve again when the only reply was deleted and the thread stays unresolved', async () => {
    const { root, fake, read, post } = await setUp();
    const confirmed = confirmContext(root, async () => true);
    const viewer = { login: 'sqve', bot: false };

    fake.threads = [
      thread({
        id: 'thread-self',
        comments: [
          { id: 101, author: viewer, body: 'Why this way?' },
          { id: 102, author: bot, body: 'Agreed.' },
        ],
      }),
    ];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-self', null)],
      comment: null,
    });

    fake.failWrite(1);
    await postFailure(post(details, confirmed));

    fake.threads = [
      thread({ id: 'thread-self', comments: [{ id: 101, author: viewer, body: 'Why this way?' }] }),
    ];

    const retry = await post(details, confirmed);

    expect(retry).toMatchObject({ status: 'posted' });
    expect(fake.writes).toEqual([{ kind: 'resolve', threadId: 'thread-self' }]);
  });
});

describe('post uncertain reply with an earlier matching comment', () => {
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
});
