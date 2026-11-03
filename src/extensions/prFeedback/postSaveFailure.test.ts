import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  botThread,
  personThread,
  postFailure,
  readPosted,
  recordedReply,
  recordingConfirm,
  replyTo,
  setUp,
  writeReplies,
} from './fixtures/postRound.js';

const fileFaults = vi.hoisted(() => ({
  failPostedSave: undefined as ((writes: readonly { state: string }[]) => boolean) | undefined,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const faultyWriteFile: typeof original.writeFile = async (path, data, options) => {
    const failPostedSave = fileFaults.failPostedSave;
    const isPostedSave = typeof path === 'string' && /\/\.posted\.json\.[^/]+$/u.test(path);

    if (isPostedSave && failPostedSave !== undefined && typeof data === 'string') {
      const saved = JSON.parse(data) as { writes: { state: string }[] };

      if (failPostedSave(saved.writes)) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
    }

    await original.writeFile(path, data, options);
  };

  return {
    ...original,
    writeFile: faultyWriteFile,
    default: { ...original, writeFile: faultyWriteFile },
  };
});

const failSaves = (predicate: (writes: readonly { state: string }[]) => boolean): void => {
  fileFaults.failPostedSave = predicate;

  onTestFinished(() => {
    fileFaults.failPostedSave = undefined;
  });
};

describe('post save failure', () => {
  it('names the write that posted.json could not record as posted', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [personThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-person', 'Renamed.')],
      comment: null,
    });

    failSaves((writes) => writes.some((write) => write.state === 'posted'));

    const failure = await postFailure(post(details, recordingConfirm(root, true).context));

    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 101, body: 'Renamed.' }]);

    expect(failure?.message).toContain(
      'Reply to https://github.com/sQVe/tau/pull/7#discussion_r101:\nRenamed.\nposted.json records it as uncertain',
    );

    expect(fake.threads[0]?.isResolved).toBe(false);

    fileFaults.failPostedSave = undefined;

    const retry = await post(details, recordingConfirm(root, true).context);

    expect(retry).toMatchObject({
      posted: [{ kind: 'resolve', thread: 'thread-person' }],
      skipped: [{ kind: 'reply', thread: 'thread-person', commentId: 1000 }],
    });

    expect(fake.writes).toEqual([
      { kind: 'reply', replyTo: 101, body: 'Renamed.' },
      { kind: 'resolve', threadId: 'thread-person' },
    ]);
  });
});

describe('post save failure around an uncertain write', () => {
  const botReplies = {
    version: 1,
    threads: [replyTo('thread-bot', 'Added.', false)],
    comment: null,
  };

  it('sends nothing when saving the uncertain record before a write fails', async () => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, botReplies);
    failSaves(() => true);

    const failure = await postFailure(post(details));

    expect(failure?.message).toContain('ENOSPC');
    expect(fake.writes).toEqual([]);
    expect(await readPosted(details.directory)).toBeUndefined();

    fileFaults.failPostedSave = undefined;

    expect(await post(details)).toMatchObject({ status: 'posted' });
    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 201, body: 'Added.' }]);
  });

  it('settles a write whose save after the send failed without sending it again', async () => {
    const { fake, read, post } = await setUp();

    fake.threads = [botThread()];

    const details = await read();

    await writeReplies(details.directory, botReplies);
    failSaves((writes) => writes.some((write) => write.state === 'posted'));

    const failure = await postFailure(post(details));

    expect(failure).toBeInstanceOf(Error);

    expect(await readPosted(details.directory)).toEqual({
      version: 2,
      writes: [
        {
          ...recordedReply('thread-bot', 'Added.', null),
          state: 'uncertain',
          earlierCommentIds: [201],
        },
      ],
    });

    fileFaults.failPostedSave = undefined;

    expect(await post(details)).toMatchObject({ status: 'unchanged' });
    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 201, body: 'Added.' }]);

    expect(await readPosted(details.directory)).toMatchObject({
      writes: [{ kind: 'reply', state: 'posted', commentId: 1000 }],
    });
  });
});
