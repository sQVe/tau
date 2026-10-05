import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import {
  readPosted,
  readPullRequestRecord,
  readReplies,
  writePosted,
  writePullRequestRecord,
} from './replies.js';

const fixtures = join(import.meta.dirname, 'fixtures');

const roundDirectory = async (fixture?: { kind: string; name: string; file: string }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-pr-feedback-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  if (fixture !== undefined) {
    await copyFile(join(fixtures, fixture.kind, fixture.name), join(directory, fixture.file));
  }

  return directory;
};

const records = [
  { kind: 'replies', file: 'replies.json', read: readReplies },
  { kind: 'posted', file: 'posted.json', read: readPosted },
  { kind: 'pull-request', file: 'pull-request.json', read: readPullRequestRecord },
];

describe('saved records', () => {
  it.each(records)('reads a version 1 $file', async ({ kind, file, read }) => {
    const directory = await roundDirectory({ kind, name: 'version-1.json', file });

    await expect(read(directory)).resolves.toBeDefined();
  });

  it.each(records)('rejects a malformed $file', async ({ kind, file, read }) => {
    const directory = await roundDirectory({ kind, name: 'malformed.json', file });

    await expect(read(directory)).rejects.toThrow(/^Malformed .*\.json: /u);
  });

  it.each(records)('rejects a newer $file', async ({ kind, file, read }) => {
    const directory = await roundDirectory({ kind, name: 'newer.json', file });

    await expect(read(directory)).rejects.toThrow(/has a newer format than this Tau reads/u);
  });

  it('reads a version 2 posted.json as saved', async () => {
    const directory = await roundDirectory({
      kind: 'posted',
      name: 'version-2.json',
      file: 'posted.json',
    });

    expect((await readPosted(directory)).writes.map((write) => write.state)).toEqual([
      'posted',
      'uncertain',
      'uncertain',
    ]);
  });

  it('reads every write in a version 1 posted.json as posted', async () => {
    const directory = await roundDirectory({
      kind: 'posted',
      name: 'version-1.json',
      file: 'posted.json',
    });

    expect(await readPosted(directory)).toMatchObject({
      version: 2,
      writes: [
        { kind: 'reply', state: 'posted', commentId: 1000 },
        { kind: 'resolve', state: 'posted', commentId: null },
      ],
    });
  });

  it('rejects text that is not JSON', async () => {
    const directory = await roundDirectory();

    await writeFile(join(directory, 'replies.json'), '{"version": 1,');

    await expect(readReplies(directory)).rejects.toThrow(/^Malformed .*replies\.json: not JSON/u);
  });
});

describe('missing records', () => {
  it('reads a missing posted.json as no writes', async () => {
    const directory = await roundDirectory();

    expect(await readPosted(directory)).toEqual({ version: 2, writes: [] });
  });

  it('refuses a missing replies.json', async () => {
    const directory = await roundDirectory();

    await expect(readReplies(directory)).rejects.toThrow(/^post needs .*replies\.json/u);
  });

  it('refuses a directory without pull-request.json', async () => {
    const directory = await roundDirectory();

    await expect(readPullRequestRecord(directory)).rejects.toThrow(
      /has no pull-request\.json\. Pass the directory that read returned/u,
    );
  });
});

describe('writing records', () => {
  it('saves records that read back and leaves no temporary file', async () => {
    const directory = await roundDirectory();
    const repository = { host: 'ghe.example.com', owner: 'sQVe', name: 'tau' };

    const writes = [
      {
        kind: 'comment' as const,
        thread: null,
        url: 'u',
        text: 'Thanks.',
        state: 'posted' as const,
        commentId: 5,
        earlierCommentIds: [],
      },
    ];

    await writePullRequestRecord(directory, { repository, pr: 7 });
    await writePosted(directory, writes);

    expect(await readPullRequestRecord(directory)).toEqual({ repository, pr: 7 });
    expect(await readPosted(directory)).toEqual({ version: 2, writes });
    expect((await readdir(directory)).toSorted()).toEqual(['posted.json', 'pull-request.json']);
  });
});
