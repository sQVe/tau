import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readViewerComments } from './viewerProtocol.js';
import type { ViewerFile } from './viewerProtocol.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'viewerProtocol', 'comments');

const files: ViewerFile[] = [
  { path: 'notes/title.md', stagedPath: '01-notes/1-title.md' },
  { path: 'notes/body.md', stagedPath: '01-notes/2-body.md' },
];

const directoryWith = async (fixture: string | undefined) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-viewer-protocol-');

  await writeFile(join(directory, 'request.json'), '{"version":1}\n');
  await writeFile(join(directory, 'review.json'), '{"version":4}\n');

  if (fixture !== undefined) {
    await cp(join(fixtures, fixture), join(directory, 'comments.json'));
  }

  return directory;
};

const recordFiles = async (directory: string) => {
  const names = (await readdir(directory)).toSorted();

  return Promise.all(
    names.map(async (name) => [name, await readFile(join(directory, name), 'utf8')] as const),
  );
};

it('maps the staged paths of a current reply back to .tau paths', async () => {
  const directory = await directoryWith('current.json');
  const before = await recordFiles(directory);

  const comments = await readViewerComments(directory, 'review-AbC123', files);

  expect(comments).toEqual([
    {
      path: 'notes/title.md',
      startLine: 1,
      endLine: 2,
      type: 'issue',
      content: 'Fix the title.',
    },
    {
      path: 'notes/body.md',
      startLine: null,
      endLine: null,
      type: 'suggestion',
      content: 'Trim the body.',
    },
  ]);

  expect(await recordFiles(directory)).toEqual(before);
});

it('gives undefined when the record holds no comments.json', async () => {
  const directory = await directoryWith(undefined);
  const before = await recordFiles(directory);

  expect(await readViewerComments(directory, 'review-AbC123', files)).toBe(undefined);
  expect(await recordFiles(directory)).toEqual(before);
});

it.each([
  { name: 'a malformed reply', fixture: 'malformed.json', message: /Malformed viewer comments/ },
  { name: 'a newer version', fixture: 'newer.json', message: /newer format/ },
  {
    name: 'a foreign review ID',
    fixture: 'foreign-id.json',
    message: /belongs to review review-Other9/,
  },
  {
    name: 'a file outside the request',
    fixture: 'path-outside.json',
    message: /01-notes\/3-other\.md is not a file of this review/,
  },
  { name: 'an error state', fixture: 'error.json', message: /reported an error/ },
])(
  'refuses $name with a message that names the comments.json path',
  async ({ fixture, message }) => {
    const directory = await directoryWith(fixture);
    const path = join(directory, 'comments.json');
    const before = await recordFiles(directory);

    await expect(readViewerComments(directory, 'review-AbC123', files)).rejects.toThrow(message);
    await expect(readViewerComments(directory, 'review-AbC123', files)).rejects.toThrow(path);
    expect(await recordFiles(directory)).toEqual(before);
  },
);

it('refuses a field the schema does not know', async () => {
  const directory = await directoryWith(undefined);

  await writeFile(
    join(directory, 'comments.json'),
    JSON.stringify({
      version: 1,
      reviewId: 'review-AbC123',
      state: 'open',
      comments: [],
      extra: 1,
    }),
  );

  const before = await recordFiles(directory);

  await expect(readViewerComments(directory, 'review-AbC123', files)).rejects.toThrow(
    /Malformed viewer comments/,
  );

  expect(await recordFiles(directory)).toEqual(before);
});

it('reports the error reason the viewer sent', async () => {
  const directory = await directoryWith('error.json');
  const before = await recordFiles(directory);

  await expect(readViewerComments(directory, 'review-AbC123', files)).rejects.toThrow(
    /The viewer could not open the drafts\./,
  );

  expect(await recordFiles(directory)).toEqual(before);
});
