import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { readTranscriptChunk } from './improvement.ts';

const directory = () => temporaryDirectory(onTestFinished, 'tau-transcript-chunk-');

const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

describe('readTranscriptChunk', () => {
  it('stops at the last newline', async () => {
    const path = join(directory(), 'session.jsonl');
    const content = 'one\ntwo\npartial';

    write(path, content);

    const first = await readTranscriptChunk(path, 0, 100);

    expect(first).toEqual({ status: 'read', text: 'one\ntwo\n', nextOffset: 8, size: 15 });

    appendFileSync(path, ' line\n');

    const second = await readTranscriptChunk(path, 8, 100);

    expect(second).toEqual({ status: 'read', text: 'partial line\n', nextOffset: 21, size: 21 });
  });

  it('reads past the byte limit to the next newline', async () => {
    const path = join(directory(), 'session.jsonl');

    write(path, 'aaaa\nbbbb\ncccc\n');

    expect(await readTranscriptChunk(path, 0, 2)).toEqual({
      status: 'read',
      text: 'aaaa\n',
      nextOffset: 5,
      size: 15,
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
    });

    expect(await readTranscriptChunk(path, 5, 1)).toEqual({
      status: 'read',
      text: 'é\n',
      nextOffset: 8,
      size: 8,
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
    });

    expect(await readTranscriptChunk(path, 9, 100)).toEqual({
      status: 'read',
      text: '',
      nextOffset: 9,
      size: 16,
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
  });
});
