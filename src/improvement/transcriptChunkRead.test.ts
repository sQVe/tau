import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { readTranscriptChunk } from './improvement.ts';
import { continueTranscript, finishTranscript } from './transcript.ts';

type PositionalRead = (
  this: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => ReturnType<FileHandle['read']>;

const directory = () => temporaryDirectory(onTestFinished, 'tau-transcript-chunk-');

const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

const mockRead = async (path: string, makeRead: (read: PositionalRead) => PositionalRead) => {
  const probe = await open(path);
  const handle = Object.getPrototypeOf(probe) as FileHandle;

  await probe.close();

  const read = handle.read as PositionalRead;
  const spy = vi.spyOn(handle, 'read').mockImplementation(makeRead(read) as FileHandle['read']);

  onTestFinished(() => {
    spy.mockRestore();
  });
};

describe('readTranscriptChunk', () => {
  it('stops at the last newline', async () => {
    const path = join(directory(), 'session.jsonl');
    const content = 'one\ntwo\npartial';

    write(path, content);

    const first = await readTranscriptChunk(path, 0, 100);

    expect(first).toEqual({
      status: 'read',
      text: 'one\ntwo\n',
      nextOffset: 8,
      size: 15,
      skippedLines: 0,
    });

    appendFileSync(path, ' line\n');

    const second = await readTranscriptChunk(path, 8, 100);

    expect(second).toEqual({
      status: 'read',
      text: 'partial line\n',
      nextOffset: 21,
      size: 21,
      skippedLines: 0,
    });
  });

  it('reads past the byte limit to the next newline', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, 'aaaa\nbbbb\ncccc\n');

    expect(await readTranscriptChunk(path, 0, 2)).toEqual({
      status: 'read',
      text: 'aaaa\n',
      nextOffset: 5,
      size: 15,
      skippedLines: 0,
    });
  });

  it('never splits a multibyte character', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, '😀\né\n');

    expect(await readTranscriptChunk(path, 0, 1)).toEqual({
      status: 'read',
      text: '😀\n',
      nextOffset: 5,
      size: 8,
      skippedLines: 0,
    });

    expect(await readTranscriptChunk(path, 5, 1)).toEqual({
      status: 'read',
      text: 'é\n',
      nextOffset: 8,
      size: 8,
      skippedLines: 0,
    });
  });

  it('returns no progress when only a partial line remains', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, 'complete\npartial');

    expect(await readTranscriptChunk(path, 0, 100)).toEqual({
      status: 'read',
      text: 'complete\n',
      nextOffset: 9,
      size: 16,
      skippedLines: 0,
    });

    expect(await readTranscriptChunk(path, 9, 100)).toEqual({
      status: 'read',
      text: '',
      nextOffset: 9,
      size: 16,
      skippedLines: 0,
    });
  });

  it('reports missing and unreadable files', async () => {
    const folder = directory();

    expect(await readTranscriptChunk(join(folder, 'gone.jsonl'), 0, 10)).toEqual({
      status: 'missing',
    });

    expect(await readTranscriptChunk(folder, 0, 10)).toMatchObject({ status: 'unreadable' });
  });

  it('rejects invalid offsets and byte limits', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, 'one\n');

    await expect(readTranscriptChunk(path, -1, 10)).rejects.toThrow(/offset/u);
    await expect(readTranscriptChunk(path, 1.5, 10)).rejects.toThrow(/offset/u);
    await expect(readTranscriptChunk(path, 0, 0)).rejects.toThrow(/byteLimit/u);
    await expect(readTranscriptChunk(path, 0, 1.5)).rejects.toThrow(/byteLimit/u);
  });

  it('assembles a chunk from short reads', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, 'aaaa\n');

    await mockRead(
      path,
      (read) =>
        function (buffer, offset, length, position) {
          return read.call(this, buffer, offset, Math.min(length, 1), position);
        },
    );

    expect(await readTranscriptChunk(path, 0, 2)).toEqual({
      status: 'read',
      text: 'aaaa\n',
      nextOffset: 5,
      size: 5,
      skippedLines: 0,
    });
  });

  it('stops when a read returns no bytes', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, 'one\n');

    await mockRead(path, (read) => {
      let zeroReads = 2;

      return function (buffer, offset, length, position) {
        if (zeroReads > 0) {
          zeroReads -= 1;

          return Promise.resolve({ bytesRead: 0, buffer });
        }

        return read.call(this, buffer, offset, length, position);
      };
    });

    expect(await readTranscriptChunk(path, 0, 10)).toEqual({
      status: 'read',
      text: '',
      nextOffset: 0,
      size: 4,
      skippedLines: 0,
    });
  });

  it('skips a line over the cap and counts it', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, '123456\nok\n');

    expect(await readTranscriptChunk(path, 0, 100, 5)).toEqual({
      status: 'read',
      text: 'ok\n',
      nextOffset: 10,
      size: 10,
      skippedLines: 1,
    });
  });

  it('skips a long line that crosses the read window', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, '123456789\nok\n');

    expect(await readTranscriptChunk(path, 0, 2, 5)).toEqual({
      status: 'read',
      text: '',
      nextOffset: 10,
      size: 13,
      skippedLines: 1,
    });

    expect(await readTranscriptChunk(path, 10, 2, 5)).toEqual({
      status: 'read',
      text: 'ok\n',
      nextOffset: 13,
      size: 13,
      skippedLines: 0,
    });
  });

  it('leaves a partial line unread even when it is over the cap', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, '123456');

    expect(await readTranscriptChunk(path, 0, 100, 5)).toEqual({
      status: 'read',
      text: '',
      nextOffset: 0,
      size: 6,
      skippedLines: 0,
    });
  });

  it('marks a transcript malformed when a line is skipped', async () => {
    const path = join(directory(), 'session.jsonl');
    const header = '{"type":"session","cwd":"/w"}\n';

    write(path, `${header}${'x'.repeat(50)}\n`);

    const chunk = await readTranscriptChunk(path, 0, 200, 40);

    if (chunk.status !== 'read') {
      throw new Error('The chunk is not readable.');
    }

    const state = continueTranscript(undefined, chunk.text);

    const finished = finishTranscript({
      ...state,
      malformedLines: state.malformedLines + chunk.skippedLines,
    });

    expect(finished.status).toBe('malformed');
  });

  it('rejects an invalid line cap', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, 'one\n');

    await expect(readTranscriptChunk(path, 0, 10, 0)).rejects.toThrow(/maxLineBytes/u);
    await expect(readTranscriptChunk(path, 0, 10, 1.5)).rejects.toThrow(/maxLineBytes/u);
  });

  it('skips a line over the cap that spans several reads', async () => {
    const path = join(directory(), 'session.jsonl');
    const longLength = 80 * 1024;
    const size = longLength + 4;

    write(path, `${'x'.repeat(longLength)}\nok\n`);

    await mockRead(
      path,
      (read) =>
        function (buffer, offset, length, position) {
          return read.call(this, buffer, offset, Math.min(length, 4096), position);
        },
    );

    expect(await readTranscriptChunk(path, 0, 10, 100)).toEqual({
      status: 'read',
      text: '',
      nextOffset: longLength + 1,
      size,
      skippedLines: 1,
    });

    expect(await readTranscriptChunk(path, longLength + 1, 10, 100)).toEqual({
      status: 'read',
      text: 'ok\n',
      nextOffset: size,
      size,
      skippedLines: 0,
    });
  });
});
