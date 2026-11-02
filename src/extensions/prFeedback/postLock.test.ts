import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import {
  bot,
  botThread,
  pausedSession,
  personThread,
  postFailure,
  readPosted,
  recordedWrite,
  recordingConfirm,
  replyTo,
  setUp,
  writeReplies,
} from './fixtures/postRound.js';

const linkBarrier = vi.hoisted(() => ({
  current: undefined as
    | {
        entered: PromiseWithResolvers<undefined>;
        released: PromiseWithResolvers<undefined>;
      }
    | undefined,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const gatedLink: typeof original.link = async (existing, created) => {
    const barrier = linkBarrier.current;

    linkBarrier.current = undefined;

    if (barrier !== undefined) {
      barrier.entered.resolve(undefined);
      await barrier.released.promise;
    }

    await original.link(existing, created);
  };

  return {
    ...original,
    link: gatedLink,
    default: { ...original, link: gatedLink },
  };
});

const stallLockLink = () => {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();

  linkBarrier.current = { entered, released };

  onTestFinished(() => {
    linkBarrier.current = undefined;
  });

  return {
    entered: entered.promise,
    release: () => {
      released.resolve(undefined);
    },
  };
};

describe('post settled writes', () => {
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
    const lock = stallLockLink();
    const retry = post(details);

    await lock.entered;

    const saved = JSON.parse(await readFile(join(details.directory, 'posted.json'), 'utf8')) as {
      writes: unknown[];
    };

    await writeFile(
      join(details.directory, 'posted.json'),
      JSON.stringify({ version: 2, writes: [...saved.writes, otherSession] }),
    );

    lock.release();

    expect(await retry).toMatchObject({ status: 'unchanged' });
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

    const lock = stallLockLink();
    const retry = post(details);

    await lock.entered;

    const saved = JSON.parse(await readFile(join(details.directory, 'posted.json'), 'utf8')) as {
      writes: unknown[];
    };

    await writeFile(
      join(details.directory, 'posted.json'),
      JSON.stringify({ version: 2, writes: [...saved.writes, otherSession] }),
    );

    lock.release();

    expect(await retry).toMatchObject({ status: 'unchanged' });
    expect(fake.writes).toHaveLength(1);

    expect(await readPosted(details.directory)).toMatchObject({
      writes: [{ kind: 'reply', state: 'posted', commentId: 1000 }, otherSession],
    });
  });
});

const exitedProcessId = async () => {
  const session = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });

  await new Promise((resolve) => {
    session.once('close', resolve);
  });

  return session.pid ?? 0;
};

const runningGroup = () => {
  const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: true,
  });

  onTestFinished(() => {
    command.kill('SIGKILL');
  });

  return command.pid ?? 0;
};

const killLockSession = async (directory: string) => {
  const names = await readdir(directory);
  const lockName = names.find((name) => /^post\.lock\.\d+$/u.test(name));

  if (lockName === undefined) {
    throw new Error(`${directory} holds no round lock.`);
  }

  const path = join(directory, lockName);
  const owner = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

  await writeFile(path, JSON.stringify({ ...owner, pid: await exitedProcessId() }));
};

describe('post from two sessions', () => {
  const botReplies = {
    version: 1,
    threads: [replyTo('thread-bot', 'Added.', false)],
    comment: null,
  };

  it('sends a write once when another session posts the round during the write', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, botReplies);

    const sessionA = pausedSession(fake);
    const postA = postFailure(post(details, noUiContext(root), {}, sessionA.tool));

    await sessionA.entered;

    const failureB = await postFailure(post(details));

    sessionA.open();

    expect(await postA).toBeUndefined();
    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 201, body: 'Added.' }]);
    expect(failureB).toBeInstanceOf(Error);

    expect(await readPosted(details.directory)).toEqual({
      version: 2,
      writes: [recordedWrite('reply', 'thread-bot', 'Added.', 1000)],
    });
  });

  it('sends nothing while a write of a session that died still runs', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, botReplies);
    fake.commandGroup = runningGroup();

    const sessionA = pausedSession(fake);
    const postA = postFailure(post(details, noUiContext(root), {}, sessionA.tool));

    await sessionA.entered;
    await killLockSession(details.directory);

    const failureB = await postFailure(post(details));

    expect(failureB).toBeInstanceOf(Error);
    expect(fake.writes).toEqual([]);

    sessionA.open();

    expect(await postA).toBeUndefined();
    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 201, body: 'Added.' }]);
  });

  it('lets another session post while the user answers the confirm', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [personThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-person', 'Renamed.', false)],
      comment: null,
    });

    let resultB: unknown;

    const { context } = recordingConfirm(root, true, async () => {
      resultB = await post(details, recordingConfirm(root, true).context);
    });

    const failureA = await postFailure(post(details, context));

    expect(resultB).toMatchObject({ status: 'posted' });
    expect(failureA?.message).toMatch(/read again/u);
    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 101, body: 'Renamed.' }]);
    expect(await post(details)).toMatchObject({ status: 'unchanged' });
  });

  it('leaves the round to the next post after the user declines', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [personThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-person', 'Renamed.', false)],
      comment: null,
    });

    expect(await post(details, recordingConfirm(root, false).context)).toMatchObject({
      status: 'declined',
    });

    expect(await post(details, recordingConfirm(root, true).context)).toMatchObject({
      status: 'posted',
    });

    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 101, body: 'Renamed.' }]);
  });
});
