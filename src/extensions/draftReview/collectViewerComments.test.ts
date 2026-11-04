import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { expect, it, vi } from 'vitest';

const hooks: { afterRead: ((path: string) => Promise<void>) | undefined } = {
  afterRead: undefined,
};

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    readFile: (async (...parameters: Parameters<typeof original.readFile>) => {
      const contents = await original.readFile(...parameters);

      const [path] = parameters;

      if (typeof path === 'string') {
        await hooks.afterRead?.(path);
      }

      return contents;
    }) as typeof original.readFile,
  };
});

const { comment, fixture, stagingOf } = await import('./fixtures/reviewFixture.js');

const protocolFixtures = join(import.meta.dirname, 'fixtures', 'viewerProtocol');

const protocolText = (name: string) => readFile(join(protocolFixtures, name), 'utf8');

const openNotes = async () => {
  const context = await fixture();

  await mkdir(context.real('notes'), { recursive: true });
  await writeFile(context.real('notes/title.md'), 'Title\n');
  await writeFile(context.real('notes/body.md'), 'Body\n');

  const opened = await context.run({
    action: 'open',
    paths: ['.tau/notes/title.md', '.tau/notes/body.md'],
  });

  if (opened.details.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  const { directory, command } = opened.details;
  const reviewId = basename(directory);

  return { ...context, directory, reviewId, staging: stagingOf(command) };
};

const writeComments = async (context: Awaited<ReturnType<typeof openNotes>>, name: string) => {
  const text = await protocolText(name);

  await writeFile(
    join(context.directory, 'comments.json'),
    text.replaceAll('review-AbC123', context.reviewId),
  );
};

it('writes a request.json that pins the review and its staged paths', async () => {
  const context = await openNotes();
  const written = await readFile(join(context.directory, 'request.json'), 'utf8');
  const expected = await protocolText('request/current.json');

  expect(written).toBe(expected.replaceAll('review-AbC123', context.reviewId));
});

it('returns the comments.json comments with absolute .tau paths and never reads tuicr', async () => {
  const context = await openNotes();

  await writeComments(context, 'comments/current.json');

  const collected = await context.run({ action: 'collect', directory: context.directory });

  expect(collected.details).toMatchObject({
    status: 'reviewed',
    comments: [
      {
        path: context.real('notes/title.md'),
        startLine: 1,
        endLine: 2,
        type: 'issue',
        content: 'Fix the title.',
      },
      {
        path: context.real('notes/body.md'),
        startLine: null,
        endLine: null,
        type: 'suggestion',
        content: 'Trim the body.',
      },
    ],
  });

  expect(context.calls.filter(({ command }) => command === 'tuicr')).toEqual([]);
});

it.each([
  { name: 'a newer version', fixture: 'comments/newer.json' },
  { name: 'a malformed reply', fixture: 'comments/malformed.json' },
  { name: 'a foreign review ID', fixture: 'comments/foreign-id.json' },
  { name: 'a file outside the request', fixture: 'comments/path-outside.json' },
  { name: 'an error state', fixture: 'comments/error.json' },
])('refuses $name before changing any file', async ({ fixture: name }) => {
  const context = await openNotes();
  const realFile = context.real('notes/title.md');
  const stagedFile = join(context.staging, '01-notes/1-title.md');

  await writeFile(stagedFile, 'Edited title\n');
  await writeComments(context, name);

  const realBefore = await readFile(realFile, 'utf8');
  const stagedBefore = await readFile(stagedFile, 'utf8');
  const commentsPath = join(context.directory, 'comments.json');

  await expect(context.run({ action: 'collect', directory: context.directory })).rejects.toThrow(
    commentsPath,
  );

  expect(await readFile(realFile, 'utf8')).toBe(realBefore);
  expect(await readFile(stagedFile, 'utf8')).toBe(stagedBefore);
  expect(existsSync(join(context.directory, 'collected.json'))).toBe(false);
  expect(existsSync(context.directory)).toBe(true);
});

it('returns the comments.json comments again on a retry and applies the remaining edit', async () => {
  const context = await openNotes();
  const titleReal = context.real('notes/title.md');
  const bodyReal = context.real('notes/body.md');
  const outside = join(context.repository, 'outside.md');

  await writeFile(join(context.staging, '01-notes/1-title.md'), 'Edited title\n');
  await writeFile(join(context.staging, '01-notes/2-body.md'), 'Edited body\n');
  await writeFile(outside, 'outside\n');
  await writeComments(context, 'comments/current.json');

  hooks.afterRead = async (path) => {
    if (path === bodyReal) {
      hooks.afterRead = undefined;
      await rm(bodyReal);
      await symlink(outside, bodyReal);
    }
  };

  await expect(context.run({ action: 'collect', directory: context.directory })).rejects.toThrow(
    /symbolic link/,
  );

  expect(await readFile(titleReal, 'utf8')).toBe('Edited title\n');
  expect(await readFile(bodyReal, 'utf8')).toBe('outside\n');
  expect(existsSync(join(context.directory, 'collected.json'))).toBe(true);

  await rm(bodyReal);
  await writeFile(bodyReal, 'Body\n');

  const collected = await context.run({ action: 'collect', directory: context.directory });

  expect(collected.details).toMatchObject({
    status: 'reviewed',
    comments: [
      { path: titleReal, content: 'Fix the title.' },
      { path: bodyReal, content: 'Trim the body.' },
    ],
    edits: [
      { path: titleReal, status: 'applied' },
      { path: bodyReal, status: 'applied' },
    ],
  });

  expect(await readFile(bodyReal, 'utf8')).toBe('Edited body\n');
});

it('refuses a viewer reply when a tuicr collect already deleted a comment', async () => {
  const context = await openNotes();
  const titleReal = context.real('notes/title.md');

  await writeFile(join(context.staging, '01-notes/1-title.md'), 'Edited title\n');

  await context.setSession([
    comment('on-title', '01-notes/1-title.md'),
    comment('on-body', '01-notes/2-body.md'),
  ]);

  await writeFile(join(context.data, 'fail.txt'), 'on-body');

  await expect(context.run({ action: 'collect', directory: context.directory })).rejects.toThrow(
    /Could not delete tuicr comment on-body/,
  );

  expect(await context.deleted()).toEqual(['on-title']);

  await writeComments(context, 'comments/current.json');

  const failure = await context
    .run({ action: 'collect', directory: context.directory })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(context.directory);
  expect(await context.deleted()).toEqual(['on-title']);
  expect(await readFile(titleReal, 'utf8')).toBe('Title\n');
});

it.each([
  { name: 'a foreign review ID', fixture: 'comments/foreign-id.json' },
  { name: 'a malformed reply', fixture: 'comments/malformed.json' },
  { name: 'a newer version', fixture: 'comments/newer.json' },
])('refuses $name on retry and reports the edit already applied', async ({ fixture: name }) => {
  const context = await openNotes();
  const titleReal = context.real('notes/title.md');
  const bodyReal = context.real('notes/body.md');
  const outside = join(context.repository, 'outside.md');
  const commentsPath = join(context.directory, 'comments.json');
  const collectedPath = join(context.directory, 'collected.json');

  await writeFile(join(context.staging, '01-notes/1-title.md'), 'Edited title\n');
  await writeFile(join(context.staging, '01-notes/2-body.md'), 'Edited body\n');
  await writeFile(outside, 'outside\n');
  await writeComments(context, 'comments/current.json');

  hooks.afterRead = async (path) => {
    if (path === bodyReal) {
      hooks.afterRead = undefined;
      await rm(bodyReal);
      await symlink(outside, bodyReal);
    }
  };

  await expect(context.run({ action: 'collect', directory: context.directory })).rejects.toThrow(
    /symbolic link/,
  );

  await rm(bodyReal);
  await writeFile(bodyReal, 'Body\n');
  await writeComments(context, name);

  const commentsBefore = await readFile(commentsPath, 'utf8');
  const collectedBefore = await readFile(collectedPath, 'utf8');

  const failure = await context
    .run({ action: 'collect', directory: context.directory })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(commentsPath);
  expect((failure as Error).message).toMatch(/Written files: notes\/title\.md\./);

  expect(await readFile(titleReal, 'utf8')).toBe('Edited title\n');
  expect(await readFile(bodyReal, 'utf8')).toBe('Body\n');
  expect(await readFile(commentsPath, 'utf8')).toBe(commentsBefore);
  expect(await readFile(collectedPath, 'utf8')).toBe(collectedBefore);
});
